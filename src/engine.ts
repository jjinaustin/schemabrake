// The checker itself, free of Node APIs so the website's playground runs exactly this code.
// File discovery and down-migration lookup live in analyze.ts.
import { lineAtByte, parseStatements, type Statement, toBytes, unwrapDoBlock } from "./sql.js";
import {
  type FileContext,
  type Finding,
  type Orm,
  type RuleId,
  STATEMENT_RULES,
  missingDownMigration,
  tableKey,
} from "./rules.js";

export interface FileReport {
  path: string;
  orm: Orm;
  findings: Finding[];
  /** Set when the file could not be parsed; no rules ran. */
  error?: { message: string; line?: number };
}

export interface AnalyzeOptions {
  /** Force the ORM instead of detecting it from the path and contents. */
  orm?: Orm;
  disabled?: Set<RuleId>;
  /**
   * Whether a down migration exists for this file. The engine has no filesystem, so this defaults
   * to false here; `analyzeSql` in analyze.ts fills it in from the files beside the migration.
   */
  hasDownMigration?: boolean;
}

const IGNORE = /schemabrake-ignore(?!-file)(?:[ \t]*:?[ \t]*(HAZ-\d+(?:[ \t]*,[ \t]*HAZ-\d+)*))?/g;
const IGNORE_FILE = /schemabrake-ignore-file/;

export function detectOrm(path: string, sql: string): Orm {
  if (sql.includes("--> statement-breakpoint")) return "drizzle";
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)migrations\/[^/]+\/migration\.sql$/.test(p)) return "prisma";
  if (/(^|\/)drizzle\//.test(p)) return "drizzle";
  return "sql";
}

/** Rules switched off by `-- schemabrake-ignore [HAZ-xx, ...]` comments; "all" when no IDs follow. */
function ignoredBy(comments: string): Set<string> | "all" {
  const ids = new Set<string>();
  for (const m of comments.matchAll(IGNORE)) {
    if (!m[1]) return "all";
    for (const id of m[1].split(",")) ids.add(id.trim());
  }
  return ids;
}

export async function analyzeSql(path: string, sql: string, opts: AnalyzeOptions = {}): Promise<FileReport> {
  const orm = opts.orm ?? detectOrm(path, sql);
  const disabled = opts.disabled ?? new Set<RuleId>();
  if (IGNORE_FILE.test(sql)) return { path, orm, findings: [] };

  const bytes = toBytes(sql);
  const statements: Statement[] = [];
  try {
    for (const stmt of await parseStatements(sql)) {
      statements.push(stmt, ...(await unwrapDoBlock(stmt, bytes)));
    }
  } catch (err: any) {
    return { path, orm, findings: [], error: { message: err.message, line: err.line } };
  }

  const ctx: FileContext = {
    orm,
    statements,
    createdTables: new Set(),
    createdIndexes: new Set(),
    lineOf: (o) => lineAtByte(bytes, o),
  };
  const findings: Finding[] = [];

  statements.forEach((stmt, i) => {
    const ignored = ignoredBy(stmt.leadingComments);
    if (ignored !== "all") {
      for (const [id, rule] of Object.entries(STATEMENT_RULES)) {
        if (disabled.has(id as RuleId) || ignored.has(id)) continue;
        findings.push(...rule(stmt, i, ctx));
      }
    }
    // Registered after the rules run, so a table only counts as new for statements that follow it.
    if (stmt.kind === "CreateStmt") ctx.createdTables.add(tableKey(stmt.node.relation));
    if (stmt.kind === "IndexStmt" && stmt.node.idxname) {
      // An index lives in its table's schema.
      ctx.createdIndexes.add(tableKey({ schemaname: stmt.node.relation.schemaname, relname: stmt.node.idxname }));
    }
  });

  if (!disabled.has("HAZ-06")) {
    const hasDown = opts.hasDownMigration ?? false;
    const missing = hasDown ? undefined : missingDownMigration(findings, orm);
    if (missing) findings.push(missing);
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
  return { path, orm, findings };
}
