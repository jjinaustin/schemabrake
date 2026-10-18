import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSql, type FileReport } from "./analyze.js";
import { formatMarkdown, summarize } from "./report.js";
import { RULES, type RuleId, type Severity } from "./rules.js";

/** Identifies the one comment this action owns on a pull request. */
export const MARKER = "<!-- schemabrake:report -->";
const FOOTER = `<sub>Checked by [SchemaBrake](https://github.com/jjinaustin/schemabrake). No database was contacted.</sub>`;
/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_COMMENT = 65_000;

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The slice of the REST API the action needs. Swapped for a fake in tests. */
export interface GitHub {
  request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any>;
}

export function gitHubClient(token: string, apiUrl = "https://api.github.com"): GitHub {
  return {
    async request(method, path, body) {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "schemabrake-action",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${await res.text()}`);
      return res.status === 204 ? undefined : res.json();
    },
  };
}

async function paginate(gh: GitHub, path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const DEFAULT_LOCATIONS = [/(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/, /(^|\/)drizzle\/(.+\/)?[^/]+\.sql$/];

/** Whether a repo-relative path is a migration this action should check. */
export function isMigrationPath(path: string, roots: string[]): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".sql") || lower.endsWith("/down.sql") || lower === "down.sql" || lower.endsWith(".down.sql")) return false;
  if (!roots.length) return DEFAULT_LOCATIONS.some((re) => re.test(path));
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function parseRoots(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Migration files added or changed by the pull request, from the API so no git history is needed. */
export async function changedMigrations(gh: GitHub, repo: string, pr: number, roots: string[]): Promise<string[]> {
  const files = await paginate(gh, `/repos/${repo}/pulls/${pr}/files`);
  return files
    .filter((f) => f.status !== "removed" && isMigrationPath(f.filename, roots))
    .map((f) => f.filename as string)
    .sort();
}

/** Creates the action's comment, or edits it in place on later pushes. Never posts a second one. */
export async function upsertComment(
  gh: GitHub,
  repo: string,
  pr: number,
  body: string,
  opts: { createIfMissing: boolean },
): Promise<"created" | "updated" | "unchanged" | "skipped"> {
  const comments = await paginate(gh, `/repos/${repo}/issues/${pr}/comments`);
  const mine = comments.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER));
  if (mine) {
    if (mine.body === body) return "unchanged";
    await gh.request("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
    return "updated";
  }
  if (!opts.createIfMissing) return "skipped";
  await gh.request("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  return "created";
}

export function commentBody(reports: FileReport[], sha: string | undefined): string {
  const head = sha ? ` Last checked at ${sha.slice(0, 7)}.` : "";
  if (!reports.length) {
    return `${MARKER}\n## 🛡️ SchemaBrake safety report\n\nThis pull request no longer changes any migration files.${head}\n\n${FOOTER}`;
  }
  let report = formatMarkdown(reports);
  const tail = `\n\n${head.trim()}\n\n${FOOTER}`;
  if (report.length + MARKER.length + tail.length > MAX_COMMENT) {
    report = `${report.slice(0, MAX_COMMENT - MARKER.length - tail.length - 120)}\n\n…report truncated; the full report is in the job summary.`;
  }
  return `${MARKER}\n${report}${tail}`;
}

/** `::error file=...` workflow commands, so each hazard also shows on its line in the diff. */
export function annotations(reports: FileReport[]): string[] {
  const level: Record<Severity, string> = { critical: "error", warning: "warning", info: "notice" };
  const prop = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
  const msg = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const out: string[] = [];
  for (const r of reports) {
    if (r.error) out.push(`::error file=${prop(r.path)},line=${r.error.line ?? 1},title=${prop("SchemaBrake: could not parse")}::${msg(r.error.message)}`);
    for (const f of r.findings) {
      const title = prop(`${f.rule} ${RULES[f.rule].name}`);
      out.push(`::${level[f.severity]} file=${prop(r.path)},line=${f.line},title=${title}::${msg(`${f.message}\n\nFix: ${f.advice}`)}`);
    }
  }
  return out;
}

export interface ActionEnv {
  token: string;
  repo: string;
  eventName: string;
  event: any;
  workspace: string;
  roots: string[];
  failOn: Severity | "never";
  disabled: Set<RuleId>;
  comment: boolean;
  log(line: string): void;
  setOutput(name: string, value: string | number): void;
  writeSummary(markdown: string): void;
}

/** Runs the check for one workflow run and returns the process exit code. */
export async function run(env: ActionEnv, gh: GitHub): Promise<number> {
  const pr: number | undefined = env.event?.pull_request?.number;
  if (!pr) {
    env.log(`::notice title=SchemaBrake::Skipped: the ${env.eventName} event is not a pull request.`);
    return 0;
  }
  const sha: string | undefined = env.event.pull_request.head?.sha;

  const files = await changedMigrations(gh, env.repo, pr, env.roots);
  env.log(files.length ? `Checking ${files.length} migration file(s):\n  ${files.join("\n  ")}` : "No migration files changed.");

  const reports: FileReport[] = [];
  for (const file of files) {
    const abs = join(env.workspace, file);
    if (!existsSync(abs)) {
      env.log(`::error title=SchemaBrake::${file} is not on disk. Add actions/checkout before this action.`);
      return 1;
    }
    const report = await analyzeSql(abs, readFileSync(abs, "utf8"), { disabled: env.disabled });
    reports.push({ ...report, path: file });
  }

  annotations(reports).forEach((line) => env.log(line));
  const s = summarize(reports);
  for (const key of ["critical", "warning", "info"] as const) env.setOutput(key, s[key]);
  env.setOutput("files", s.files);

  const body = commentBody(reports, sha);
  if (reports.length) env.writeSummary(body.slice(MARKER.length + 1));

  if (env.comment) {
    try {
      // Only open a comment when there are migrations to report on; afterwards, keep the existing one current.
      const result = await upsertComment(gh, env.repo, pr, body, { createIfMissing: reports.length > 0 });
      env.log(`PR comment: ${result}.`);
    } catch (err: any) {
      const hint =
        err instanceof GitHubError && (err.status === 403 || err.status === 404)
          ? " The token cannot write to this pull request (pull requests from forks get a read-only token). Grant `pull-requests: write`, or read the report in the job summary."
          : "";
      env.log(`::warning title=SchemaBrake::Could not post the PR comment.${hint} ${err.message}`);
    }
  }

  if (s.errors) return 1;
  const failing =
    env.failOn === "never" ? 0 : s.critical + (env.failOn !== "critical" ? s.warning : 0) + (env.failOn === "info" ? s.info : 0);
  return failing ? 1 : 0;
}

function input(name: string, fallback = ""): string {
  return (process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback).trim();
}

async function main() {
  const failOn = input("fail-on", "critical") as Severity | "never";
  if (!["critical", "warning", "info", "never"].includes(failOn)) {
    console.log(`::error title=SchemaBrake::fail-on must be critical, warning, info or never, not "${failOn}".`);
    return 1;
  }
  const disabled = new Set(parseRoots(input("disable").toUpperCase()));
  for (const id of disabled) {
    if (!(id in RULES)) {
      console.log(`::error title=SchemaBrake::Unknown rule "${id}" in disable.`);
      return 1;
    }
  }
  const token = input("github-token");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const env: ActionEnv = {
    token,
    repo: process.env.GITHUB_REPOSITORY ?? "",
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    event: eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, "utf8")) : {},
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    roots: parseRoots(input("paths")),
    failOn,
    disabled: disabled as Set<RuleId>,
    comment: input("comment", "true") !== "false",
    log: (line) => console.log(line),
    setOutput: (name, value) => {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    },
    writeSummary: (md) => {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    },
  };
  return run(env, gitHubClient(token, process.env.GITHUB_API_URL));
}

if (process.env.GITHUB_ACTIONS === "true" && process.argv[1]?.endsWith("action.js")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error title=SchemaBrake::${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
