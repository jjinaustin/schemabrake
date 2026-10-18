import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lineAtByte, parseStatements, type Statement, unwrapDoBlock } from "./sql.js";
import {
  type FileContext,
  type Finding,
  type Orm,
  type RuleId,
  RULES,
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
  /** Whether a down migration exists for this file. Defaults to checking the filesystem. */
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

  const bytes = Buffer.from(sql, "utf8");
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
    const hasDown = opts.hasDownMigration ?? downMigrationExists(path);
    const missing = hasDown ? undefined : missingDownMigration(findings, orm);
    if (missing) findings.push(missing);
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
  return { path, orm, findings };
}

export async function analyzeFile(path: string, opts: AnalyzeOptions = {}): Promise<FileReport> {
  return analyzeSql(path, readFileSync(path, "utf8"), opts);
}

function isDownMigration(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "down.sql" || name.endsWith(".down.sql");
}

function downMigrationExists(path: string): boolean {
  const dir = dirname(path);
  const stem = basename(path).replace(/\.sql$/i, "");
  return [join(dir, "down.sql"), join(dir, `${stem}.down.sql`)].some((p) => existsSync(p));
}

/** Expands files and directories into the migration files to check, in a stable order. */
export function findMigrationFiles(paths: string[]): string[] {
  const out = new Set<string>();
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isFile()) {
      out.add(p);
      return;
    }
    for (const entry of readdirSync(p).sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = join(p, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (entry.toLowerCase().endsWith(".sql") && !isDownMigration(child)) out.add(child);
    }
  };
  paths.forEach(walk);
  return [...out];
}

export { RULES };
