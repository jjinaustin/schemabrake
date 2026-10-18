import type { Statement } from "./sql.js";

export type Severity = "critical" | "warning" | "info";
export type Orm = "prisma" | "drizzle" | "sql";
export type RuleId = "HAZ-01" | "HAZ-02" | "HAZ-03" | "HAZ-04" | "HAZ-05" | "HAZ-06" | "HAZ-07" | "HAZ-08" | "HAZ-09";

export const RULES: Record<RuleId, { name: string; severity: Severity }> = {
  "HAZ-01": { name: "Index build blocks writes", severity: "critical" },
  "HAZ-02": { name: "NOT NULL column without default", severity: "critical" },
  "HAZ-03": { name: "Irreversible data loss", severity: "critical" },
  "HAZ-04": { name: "Column type change locks table", severity: "warning" },
  "HAZ-05": { name: "Enum value added", severity: "warning" },
  "HAZ-06": { name: "No down migration", severity: "info" },
  "HAZ-07": { name: "Foreign key validated under lock", severity: "warning" },
  "HAZ-08": { name: "SET NOT NULL scans under lock", severity: "warning" },
  "HAZ-09": { name: "Index drop blocks queries", severity: "warning" },
};

export interface Finding {
  rule: RuleId;
  severity: Severity;
  line: number;
  message: string;
  advice: string;
}

export interface FileContext {
  orm: Orm;
  statements: Statement[];
  /** Tables created earlier in this same file; changes to them cannot hurt live traffic. */
  createdTables: Set<string>;
  /** Indexes created earlier in this same file, keyed like tables. */
  createdIndexes: Set<string>;
  /** Maps a UTF-8 byte offset in the file to its 1-based line. */
  lineOf(byteOffset: number): number;
}

/** A statement-level rule: returns findings for one statement. */
type StatementRule = (stmt: Statement, index: number, ctx: FileContext) => Finding[];

export function tableKey(relation: { schemaname?: string; relname: string }): string {
  return `${relation.schemaname ?? "public"}.${relation.relname}`;
}

function display(relation: { schemaname?: string; relname: string }): string {
  return relation.schemaname && relation.schemaname !== "public"
    ? `"${relation.schemaname}"."${relation.relname}"`
    : `"${relation.relname}"`;
}

function finding(rule: RuleId, line: number, message: string, advice: string): Finding {
  return { rule, severity: RULES[rule].severity, line, message, advice };
}

const isNewTable = (ctx: FileContext, relation: any) => ctx.createdTables.has(tableKey(relation));

/** HAZ-01: CREATE INDEX without CONCURRENTLY on a table that already exists. */
const indexWithoutConcurrently: StatementRule = (stmt, _i, ctx) => {
  if (stmt.kind !== "IndexStmt" || stmt.node.concurrent || isNewTable(ctx, stmt.node.relation)) return [];
  const name = stmt.node.idxname ? `"${stmt.node.idxname}" ` : "";
  const table = display(stmt.node.relation);
  const advice = {
    prisma:
      `Create the migration with \`prisma migrate dev --create-only\`, move this index into a migration file of its own, ` +
      `and change it to \`CREATE INDEX CONCURRENTLY\`. It must be the only statement in that file: PostgreSQL refuses ` +
      `CONCURRENTLY in a transaction block, and a file with several statements runs as one.`,
    drizzle:
      `Use \`CREATE INDEX CONCURRENTLY\`, applied outside the Drizzle migrator: the migrator runs pending migrations ` +
      `inside a transaction, where PostgreSQL refuses CONCURRENTLY.`,
    sql: `Use \`CREATE INDEX CONCURRENTLY\`, run outside a transaction block.`,
  }[ctx.orm];
  return [
    finding(
      "HAZ-01",
      stmt.line,
      `CREATE ${stmt.node.unique ? "UNIQUE " : ""}INDEX ${name}takes a SHARE lock on ${table}: ` +
        `every INSERT, UPDATE and DELETE on it waits until the index is built.`,
      advice,
    ),
  ];
};

const SERIAL_TYPES = new Set(["serial", "serial4", "bigserial", "serial8", "smallserial", "serial2"]);

/** HAZ-02: ADD COLUMN ... NOT NULL with no DEFAULT on a table that already exists. */
const notNullWithoutDefault: StatementRule = (stmt, _i, ctx) => {
  if (stmt.kind !== "AlterTableStmt" || isNewTable(ctx, stmt.node.relation)) return [];
  const out: Finding[] = [];
  for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
    if (cmd?.subtype !== "AT_AddColumn") continue;
    const col = cmd.def?.ColumnDef;
    if (!col) continue;
    const types: string[] = (col.constraints ?? []).map((c: any) => c.Constraint?.contype);
    const required = types.includes("CONSTR_NOTNULL") || types.includes("CONSTR_PRIMARY");
    const filled =
      types.includes("CONSTR_DEFAULT") || types.includes("CONSTR_IDENTITY") || types.includes("CONSTR_GENERATED");
    const typeName = col.typeName?.names?.at(-1)?.String?.sval?.toLowerCase();
    if (!required || filled || SERIAL_TYPES.has(typeName)) continue;

    const table = display(stmt.node.relation);
    const advice = {
      prisma:
        `Add the field as optional (\`${col.colname} String?\` or the matching type) and deploy, backfill existing rows, ` +
        `then make it required in a second migration. Alternatively give it a \`@default(...)\`.`,
      drizzle:
        `Add the column without \`.notNull()\` and deploy, backfill existing rows, then add \`.notNull()\` in a second ` +
        `migration. Alternatively give it a \`.default(...)\`.`,
      sql: `Add the column as nullable, backfill, then SET NOT NULL in a later migration; or add a DEFAULT.`,
    }[ctx.orm];
    out.push(
      finding(
        "HAZ-02",
        col.location !== undefined ? ctx.lineOf(stmt.origin + col.location) : stmt.line,
        `Adds "${col.colname}" to ${table} as NOT NULL with no DEFAULT. The migration fails if ${table} has any rows; ` +
          `if it succeeds, app instances still running the previous release fail on every INSERT that omits the column.`,
        advice,
      ),
    );
  }
  return out;
};

/** HAZ-03: DROP COLUMN or DROP TABLE on something that existed before this migration. */
const dataLoss: StatementRule = (stmt, _i, ctx) => {
  const out: Finding[] = [];
  const stopReading = {
    prisma: `Stop the code reading it first: remove it from queries (or mark it \`@ignore\`) and deploy, then drop it in a later migration.`,
    drizzle: `Stop the code reading it first: remove it from queries and the schema's selects and deploy, then drop it in a later migration.`,
    sql: `Deploy code that no longer reads it first, then drop it in a later migration.`,
  }[ctx.orm];

  if (stmt.kind === "AlterTableStmt" && !isNewTable(ctx, stmt.node.relation)) {
    for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
      if (cmd?.subtype !== "AT_DropColumn") continue;
      const rename =
        ctx.orm === "prisma"
          ? ` If you renamed the field, Prisma generated a drop and an add: edit the file to \`ALTER TABLE ... RENAME COLUMN\` instead.`
          : ctx.orm === "drizzle"
            ? ` If you renamed the column, answer "rename" when drizzle-kit asks, so it generates RENAME COLUMN.`
            : "";
      out.push(
        finding(
          "HAZ-03",
          stmt.line,
          `Drops column "${cmd.name}" from ${display(stmt.node.relation)}. Its data is gone, and app instances still running ` +
            `the previous release fail on any query that names it.`,
          stopReading + rename,
        ),
      );
    }
  }

  if (stmt.kind === "DropStmt" && stmt.node.removeType === "OBJECT_TABLE") {
    for (const obj of stmt.node.objects ?? []) {
      const parts: string[] = (obj.List?.items ?? []).map((s: any) => s.String?.sval);
      const relation = parts.length > 1 ? { schemaname: parts[0], relname: parts[1] } : { relname: parts[0] };
      if (isNewTable(ctx, relation)) continue;
      const cascade = stmt.node.behavior === "DROP_CASCADE" ? " CASCADE also drops every view and foreign key that depends on it." : "";
      out.push(
        finding(
          "HAZ-03",
          stmt.line,
          `Drops table ${display(relation)} and all of its rows.${cascade}`,
          stopReading,
        ),
      );
    }
  }
  return out;
};

/** HAZ-04: ALTER COLUMN ... TYPE. */
const columnTypeChange: StatementRule = (stmt, _i, ctx) => {
  if (stmt.kind !== "AlterTableStmt" || isNewTable(ctx, stmt.node.relation)) return [];
  const out: Finding[] = [];
  for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
    if (cmd?.subtype !== "AT_AlterColumnType") continue;
    const loc = cmd.def?.ColumnDef?.location;
    out.push(
      finding(
        "HAZ-04",
        loc !== undefined ? ctx.lineOf(stmt.origin + loc) : stmt.line,
        `Changing the type of "${cmd.name}" on ${display(stmt.node.relation)} takes an ACCESS EXCLUSIVE lock, blocking ` +
          `reads and writes, and rewrites the whole table under it unless the old and new types are binary-compatible.`,
        `On a large table: add a column with the new type, backfill it in batches, switch the code over, then drop the old column.`,
      ),
    );
  }
  return out;
};

/** HAZ-05: ALTER TYPE ... ADD VALUE. */
const enumAddValue: StatementRule = (stmt, index, ctx) => {
  if (stmt.kind !== "AlterEnumStmt" || !stmt.node.newVal || stmt.node.oldVal) return [];
  const value: string = stmt.node.newVal;
  const typeName = (stmt.node.typeName ?? []).map((s: any) => s.String?.sval).join(".");
  const literal = `'${value.replace(/'/g, "''")}'`;
  const usedAt = ctx.statements.slice(index + 1).find((s) => s.text.includes(literal));

  let message =
    `Adds ${literal} to enum "${typeName}". PostgreSQL 11 and older refuse ADD VALUE inside a transaction block; ` +
    `on 12 and later the new value cannot be used until that transaction commits.`;
  if (usedAt) message += ` Line ${usedAt.line} of this file uses ${literal}, which fails if the file runs as one transaction.`;

  const advice = {
    prisma: `Put the ADD VALUE in a migration of its own, applied before any migration that uses the value.`,
    drizzle:
      `Put the ADD VALUE in a migration of its own and deploy it before any migration that uses the value: ` +
      `the Drizzle migrator applies all pending migrations in one transaction, so a separate file in the same deploy is not enough.`,
    sql: `Run the ADD VALUE in its own transaction, committed before anything uses the value.`,
  }[ctx.orm];
  return [finding("HAZ-05", stmt.line, message, advice)];
};

/** HAZ-07: ADD CONSTRAINT ... FOREIGN KEY validated in the same transaction it is added in. */
const foreignKeyValidated: StatementRule = (stmt, index, ctx) => {
  if (stmt.kind !== "AlterTableStmt" || isNewTable(ctx, stmt.node.relation)) return [];
  const out: Finding[] = [];
  for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
    const con = cmd?.subtype === "AT_AddConstraint" ? cmd.def?.Constraint : undefined;
    if (con?.contype !== "CONSTR_FOREIGN") continue;
    const table = display(stmt.node.relation);
    const target = display(con.pktable);
    const name = con.conname ? `"${con.conname}" ` : "";
    const advice = {
      prisma:
        `Edit the migration to end the ADD CONSTRAINT with \`NOT VALID\`, then run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ...\` ` +
        `in a later migration. Validation there takes a lock that lets reads and writes continue.`,
      drizzle:
        `Edit the migration to end the ADD CONSTRAINT with \`NOT VALID\`, then run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ...\` ` +
        `in a later migration, deployed separately: the Drizzle migrator runs pending migrations in one transaction.`,
      sql: `Add it with \`NOT VALID\` and run \`VALIDATE CONSTRAINT\` in a separate transaction; validation there lets reads and writes continue.`,
    }[ctx.orm];

    if (!con.skip_validation) {
      out.push(
        finding(
          "HAZ-07",
          stmt.line,
          `Adding foreign key ${name}from ${table} to ${target} checks every existing row of ${table} while holding ` +
            `SHARE ROW EXCLUSIVE locks on both tables: writes to either wait until the check finishes.`,
          advice,
        ),
      );
      continue;
    }
    // NOT VALID, but validated later in the same file: the file runs as one transaction, so the
    // ADD CONSTRAINT's lock is still held while VALIDATE scans.
    const validatedAt = ctx.statements.slice(index + 1).find(
      (s) =>
        s.kind === "AlterTableStmt" &&
        tableKey(s.node.relation) === tableKey(stmt.node.relation) &&
        (s.node.cmds ?? []).some((c: any) => c.AlterTableCmd?.subtype === "AT_ValidateConstraint" && c.AlterTableCmd.name === con.conname),
    );
    if (validatedAt) {
      out.push(
        finding(
          "HAZ-07",
          validatedAt.line,
          `Foreign key ${name}is added NOT VALID but validated in the same migration. Both run in one transaction, so ` +
            `the SHARE ROW EXCLUSIVE locks on ${table} and ${target} are held through the whole check anyway.`,
          advice,
        ),
      );
    }
  }
  return out;
};

/** HAZ-08: ALTER COLUMN ... SET NOT NULL on an existing table. */
const setNotNull: StatementRule = (stmt, _i, ctx) => {
  if (stmt.kind !== "AlterTableStmt" || isNewTable(ctx, stmt.node.relation)) return [];
  const out: Finding[] = [];
  for (const { AlterTableCmd: cmd } of stmt.node.cmds ?? []) {
    if (cmd?.subtype !== "AT_SetNotNull") continue;
    const table = display(stmt.node.relation);
    const steps =
      `1) \`ALTER TABLE ${table} ADD CONSTRAINT ${cmd.name}_not_null CHECK ("${cmd.name}" IS NOT NULL) NOT VALID\`; ` +
      `2) in a later migration, \`VALIDATE CONSTRAINT ${cmd.name}_not_null\`, which scans without blocking writes; ` +
      `3) then SET NOT NULL, which PostgreSQL 12+ completes without a scan because the constraint proves it, and drop the CHECK.`;
    const advice = {
      prisma: `On a large table, edit the generated migration into three steps: ${steps}`,
      drizzle: `On a large table, write the change as three migrations, deployed separately: ${steps}`,
      sql: `On a large table, use three steps: ${steps}`,
    }[ctx.orm];
    out.push(
      finding(
        "HAZ-08",
        stmt.line,
        `SET NOT NULL on "${cmd.name}" takes an ACCESS EXCLUSIVE lock on ${table}, blocking reads and writes while it ` +
          `scans every row for NULLs.`,
        advice,
      ),
    );
  }
  return out;
};

/** HAZ-09: DROP INDEX without CONCURRENTLY. */
const dropIndexWithoutConcurrently: StatementRule = (stmt, _i, ctx) => {
  if (stmt.kind !== "DropStmt" || stmt.node.removeType !== "OBJECT_INDEX" || stmt.node.concurrent) return [];
  const out: Finding[] = [];
  for (const obj of stmt.node.objects ?? []) {
    const parts: string[] = (obj.List?.items ?? []).map((s: any) => s.String?.sval);
    const index = parts.length > 1 ? { schemaname: parts[0], relname: parts[1] } : { relname: parts[0] };
    if (ctx.createdIndexes.has(tableKey(index))) continue;
    const advice = {
      prisma:
        `Move it into a migration file of its own as \`DROP INDEX CONCURRENTLY\`, the only statement in that file: ` +
        `PostgreSQL refuses CONCURRENTLY in a transaction block.`,
      drizzle:
        `Use \`DROP INDEX CONCURRENTLY\`, applied outside the Drizzle migrator: the migrator runs pending migrations ` +
        `inside a transaction, where PostgreSQL refuses CONCURRENTLY.`,
      sql: `Use \`DROP INDEX CONCURRENTLY\`, one index per statement, outside a transaction block.`,
    }[ctx.orm];
    out.push(
      finding(
        "HAZ-09",
        stmt.line,
        `DROP INDEX ${display(index)} needs an ACCESS EXCLUSIVE lock on its table. The drop is quick, but it waits ` +
          `for every running query on the table, and every query that arrives after it waits behind it.`,
        advice,
      ),
    );
  }
  return out;
};

export const STATEMENT_RULES: Record<Exclude<RuleId, "HAZ-06">, StatementRule> = {
  "HAZ-01": indexWithoutConcurrently,
  "HAZ-02": notNullWithoutDefault,
  "HAZ-03": dataLoss,
  "HAZ-04": columnTypeChange,
  "HAZ-05": enumAddValue,
  "HAZ-07": foreignKeyValidated,
  "HAZ-08": setNotNull,
  "HAZ-09": dropIndexWithoutConcurrently,
};

/** HAZ-06: the file has a hazard and nothing beside it says how to undo it. */
export function missingDownMigration(findings: Finding[], orm: Orm): Finding | undefined {
  if (!findings.some((f) => f.severity !== "info")) return undefined;
  const tool = orm === "prisma" ? "Prisma" : orm === "drizzle" ? "Drizzle" : "Your migration tool";
  const dataLost = findings.some((f) => f.rule === "HAZ-03");
  return finding(
    "HAZ-06",
    1,
    `This migration has hazards and no down migration beside it. ${tool} does not generate one, so reverting means writing it during the incident.`,
    (orm === "prisma"
      ? `Generate one with \`prisma migrate diff --from-schema-datamodel <new> --to-schema-datamodel <old> --script > down.sql\` in the migration's folder.`
      : `Write the reverse SQL now and keep it next to the migration as \`down.sql\` or \`<name>.down.sql\`.`) +
      (dataLost ? ` A down migration cannot restore dropped data: take a backup or snapshot before deploying.` : ""),
  );
}
