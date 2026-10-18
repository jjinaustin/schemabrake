#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { analyzeFile, findMigrationFiles, type FileReport } from "./analyze.js";
import { formatJson, formatMarkdown, formatText, summarize } from "./report.js";
import { type Orm, type RuleId, RULES } from "./rules.js";

const USAGE = `Usage: schemabrake check [paths...] [options]

Checks PostgreSQL migration files (Prisma, Drizzle or plain SQL) for deploy hazards.
With no paths, checks ./prisma/migrations and ./drizzle if they exist.

Options:
  --format <text|markdown|json>          Output format (default: text)
  --fail-on <critical|warning|info|never> Lowest severity that fails the run (default: critical)
  --disable <HAZ-xx,...>                 Rules to skip
  --orm <prisma|drizzle|sql>             Skip detection and treat every file as this ORM's output
  -h, --help                             Show this help

Exit codes: 0 no failing hazards, 1 failing hazards found, 2 usage or parse error.
Suppress one statement with a comment above it: -- schemabrake-ignore HAZ-01`;

const SEVERITIES = ["critical", "warning", "info", "never"] as const;

function fail(message: string): never {
  console.error(`schemabrake: ${message}\n\n${USAGE}`);
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", default: "text" },
        "fail-on": { type: "string", default: "critical" },
        disable: { type: "string", default: "" },
        orm: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err: any) {
    fail(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const [command, ...paths] = positionals;
  if (command !== "check") fail(command ? `unknown command "${command}"` : "missing command");
  if (!["text", "markdown", "json"].includes(values.format!)) fail(`unknown format "${values.format}"`);
  if (!SEVERITIES.includes(values["fail-on"] as any)) fail(`unknown --fail-on "${values["fail-on"]}"`);
  if (values.orm && !["prisma", "drizzle", "sql"].includes(values.orm)) fail(`unknown ORM "${values.orm}"`);
  const disabled = new Set<string>(values.disable!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  for (const id of disabled) if (!(id in RULES)) fail(`unknown rule "${id}"`);

  const roots = paths.length ? paths : ["prisma/migrations", "drizzle"].filter((p) => existsSync(p));
  if (!roots.length) fail("no paths given and neither ./prisma/migrations nor ./drizzle exists");
  for (const p of roots) if (!existsSync(p)) fail(`no such file or directory: ${p}`);

  const files = findMigrationFiles(roots);
  const reports: FileReport[] = [];
  for (const file of files) {
    reports.push(await analyzeFile(file, { orm: values.orm as Orm | undefined, disabled: disabled as Set<RuleId> }));
  }

  if (values.format === "json") console.log(formatJson(reports));
  else if (values.format === "markdown") console.log(formatMarkdown(reports));
  else console.log(formatText(reports, process.stdout.isTTY && !process.env.NO_COLOR));

  const s = summarize(reports);
  if (s.errors) return 2;
  const failOn = values["fail-on"];
  const failing =
    failOn === "never" ? 0 : s.critical + (failOn !== "critical" ? s.warning : 0) + (failOn === "info" ? s.info : 0);
  return failing ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
