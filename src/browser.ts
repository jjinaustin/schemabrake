// Entry point for the website's playground: the same engine the Action runs, bundled for the
// browser by `npm run build:site`. The page loads it with a dynamic import().
import { loadModule } from "libpg-query";
import { analyzeSql, type FileReport } from "./engine.js";
import type { Orm } from "./rules.js";
import { RULES } from "./rules.js";

export { RULES };

/** Resolves once the PostgreSQL parser (WASM) has loaded; rejects if it cannot. */
export function ready(): Promise<void> {
  return loadModule();
}

/** Checks pasted SQL as if it were `path`. There is no filesystem, so HAZ-06 sees no down migration. */
export function check(path: string, sql: string, orm: Orm): Promise<FileReport> {
  return analyzeSql(path, sql, { orm, hasDownMigration: false });
}
