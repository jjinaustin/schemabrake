import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AnalyzeOptions, type FileReport, analyzeSql as checkSql } from "./engine.js";
import { RULES } from "./rules.js";

export { type AnalyzeOptions, type FileReport, detectOrm } from "./engine.js";

/** Checks one migration's SQL, looking for a down migration beside `path` unless told. */
export async function analyzeSql(path: string, sql: string, opts: AnalyzeOptions = {}): Promise<FileReport> {
  return checkSql(path, sql, { ...opts, hasDownMigration: opts.hasDownMigration ?? downMigrationExists(path) });
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
