import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ActionEnv,
  type GitHub,
  GitHubError,
  MARKER,
  annotations,
  commentBody,
  isMigrationPath,
  parseRoots,
  run,
} from "../src/action.js";
import { analyzeSql } from "../src/analyze.js";

const PRISMA = "prisma/migrations/20261018000000_add_stripe_id/migration.sql";
const DRIZZLE = "drizzle/0001_add_stripe.sql";

/** An in-memory pull request: its files and comments, and a log of every write. */
function fakeGitHub(opts: { files: { filename: string; status?: string }[]; comments?: any[]; denyWrites?: boolean }) {
  const comments = [...(opts.comments ?? [])];
  const writes: { method: string; path: string; body: any }[] = [];
  const pages = (all: any[], path: string) => {
    const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
    return all.slice((page - 1) * 100, page * 100);
  };
  const gh: GitHub = {
    async request(method, path, body) {
      if (method === "GET" && path.includes("/files")) return pages(opts.files.map((f) => ({ status: "added", ...f })), path);
      if (method === "GET" && path.includes("/comments")) return pages(comments, path);
      if (opts.denyWrites) throw new GitHubError(403, "Resource not accessible by integration");
      writes.push({ method, path, body });
      if (method === "POST") comments.push({ id: 900 + comments.length, ...(body as any) });
      if (method === "PATCH") {
        const id = Number(path.split("/").at(-1));
        comments.find((c) => c.id === id)!.body = (body as any).body;
      }
      return {};
    },
  };
  return { gh, comments, writes };
}

/** A checked-out workspace holding the real Prisma and Drizzle fixtures at their usual paths. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-ws-"));
  cpSync("test/fixtures/prisma", join(dir, "prisma"), { recursive: true });
  cpSync("test/fixtures/drizzle", join(dir, "drizzle"), { recursive: true });
  return dir;
}

function env(overrides: Partial<ActionEnv> = {}): ActionEnv & { logs: string[]; outputs: Record<string, string>; summary: string[] } {
  const logs: string[] = [];
  const outputs: Record<string, string> = {};
  const summary: string[] = [];
  return {
    token: "t",
    repo: "acme/app",
    eventName: "pull_request",
    event: { pull_request: { number: 7, head: { sha: "abc1234def" } } },
    workspace: workspace(),
    roots: [],
    failOn: "critical",
    disabled: new Set(),
    comment: true,
    log: (l) => logs.push(l),
    setOutput: (k, v) => (outputs[k] = String(v)),
    writeSummary: (m) => summary.push(m),
    logs,
    outputs,
    summary,
    ...overrides,
  };
}

describe("isMigrationPath", () => {
  it.each([
    [PRISMA, true],
    ["apps/web/prisma/migrations/20261018_x/migration.sql", true],
    [DRIZZLE, true],
    ["packages/db/drizzle/migrations/0003_x.sql", true],
    ["prisma/migrations/migration_lock.toml", false],
    ["prisma/schema.prisma", false],
    ["prisma/migrations/20261018_x/down.sql", false],
    ["drizzle/0001_x.down.sql", false],
    ["db/seed.sql", false],
  ])("%s → %s by default", (path, expected) => {
    expect(isMigrationPath(path, [])).toBe(expected);
  });
  it("uses only the configured directories when given", () => {
    const roots = parseRoots("./supabase/migrations/\n db/sql ");
    expect(roots).toEqual(["supabase/migrations", "db/sql"]);
    expect(isMigrationPath("supabase/migrations/20261018_x.sql", roots)).toBe(true);
    expect(isMigrationPath("db/sqlite/x.sql", roots)).toBe(false);
    expect(isMigrationPath(PRISMA, roots)).toBe(false);
  });
});

describe("run", () => {
  it("checks only the PR's migration files, comments once, and fails on critical findings", async () => {
    const { gh, comments, writes } = fakeGitHub({
      files: [{ filename: PRISMA }, { filename: "src/app.ts" }, { filename: "prisma/schema.prisma", status: "modified" }],
    });
    const e = env();
    expect(await run(e, gh)).toBe(1);
    expect(writes.map((w) => w.method)).toEqual(["POST"]);
    expect(comments[0].body.startsWith(MARKER)).toBe(true);
    expect(comments[0].body).toContain(`### \`${PRISMA}\``);
    expect(comments[0].body).toContain("Last checked at abc1234.");
    expect(e.outputs).toEqual({ files: "1", critical: "5", warning: "2", info: "1" });
    expect(e.summary[0]).toContain("SchemaBrake safety report");
  });

  it("edits its own comment on the next push instead of posting another", async () => {
    const other = { id: 1, body: "LGTM" };
    const { gh, comments, writes } = fakeGitHub({ files: [{ filename: DRIZZLE }], comments: [other] });
    await run(env(), gh);
    await run(env({ event: { pull_request: { number: 7, head: { sha: "fff9999" } } } }), gh);
    expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toBe(other);
    expect(comments[1].body).toContain("Last checked at fff9999.");
  });

  it("makes no write when the report has not changed", async () => {
    const { gh, writes } = fakeGitHub({ files: [{ filename: DRIZZLE }] });
    await run(env(), gh);
    await run(env(), gh);
    expect(writes).toHaveLength(1);
  });

  it("finds its comment past the first page of comments", async () => {
    const chatter = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: `comment ${i}` }));
    const mine = { id: 500, body: `${MARKER}\nold report` };
    const { gh, writes } = fakeGitHub({ files: [{ filename: DRIZZLE }], comments: [...chatter, mine] });
    await run(env(), gh);
    expect(writes.map((w) => [w.method, w.path])).toEqual([["PATCH", "/repos/acme/app/issues/comments/500"]]);
  });

  it("does not open a comment on a PR without migrations, but updates one left by an earlier push", async () => {
    const quiet = fakeGitHub({ files: [{ filename: "src/app.ts" }] });
    expect(await run(env(), quiet.gh)).toBe(0);
    expect(quiet.writes).toEqual([]);

    const earlier = fakeGitHub({ files: [{ filename: "src/app.ts" }], comments: [{ id: 3, body: `${MARKER}\nold` }] });
    await run(env(), earlier.gh);
    expect(earlier.comments[0].body).toContain("no longer changes any migration files");
  });

  it("ignores removed migration files", async () => {
    const { gh, writes } = fakeGitHub({ files: [{ filename: PRISMA, status: "removed" }] });
    expect(await run(env(), gh)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("still reports and fails the check when the token cannot comment", async () => {
    const { gh } = fakeGitHub({ files: [{ filename: PRISMA }], denyWrites: true });
    const e = env();
    expect(await run(e, gh)).toBe(1);
    expect(e.logs.some((l) => l.startsWith("::warning") && l.includes("read-only token"))).toBe(true);
    expect(e.summary).toHaveLength(1);
  });

  it("passes a PR with only clean migrations, and still comments to say so", async () => {
    const { gh, comments } = fakeGitHub({ files: [{ filename: "prisma/migrations/20261001000000_init/migration.sql" }] });
    expect(await run(env(), gh)).toBe(0);
    expect(comments[0].body).toContain("No hazards found.");
  });

  it("respects fail-on, disable and comment: false", async () => {
    const files = [{ filename: PRISMA }];
    expect(await run(env({ failOn: "never" }), fakeGitHub({ files }).gh)).toBe(0);
    expect(await run(env({ disabled: new Set(["HAZ-01", "HAZ-02", "HAZ-03"]) }), fakeGitHub({ files }).gh)).toBe(0);
    expect(await run(env({ disabled: new Set(["HAZ-01", "HAZ-02", "HAZ-03"]), failOn: "warning" }), fakeGitHub({ files }).gh)).toBe(1);
    const silent = fakeGitHub({ files });
    await run(env({ comment: false }), silent.gh);
    expect(silent.writes).toEqual([]);
  });

  it("fails clearly when the repository was not checked out", async () => {
    const e = env({ workspace: mkdtempSync(join(tmpdir(), "sb-empty-")) });
    expect(await run(e, fakeGitHub({ files: [{ filename: PRISMA }] }).gh)).toBe(1);
    expect(e.logs.at(-1)).toContain("Add actions/checkout");
  });

  it("fails on SQL that does not parse", async () => {
    const e = env();
    const bad = join(e.workspace, "drizzle/0002_bad.sql");
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, "CREATE TABLE (;");
    expect(await run(e, fakeGitHub({ files: [{ filename: "drizzle/0002_bad.sql" }] }).gh)).toBe(1);
  });

  it("does nothing outside pull requests", async () => {
    const { gh, writes } = fakeGitHub({ files: [] });
    expect(await run(env({ eventName: "push", event: {} }), gh)).toBe(0);
    expect(writes).toEqual([]);
  });
});

describe("annotations", () => {
  it("emits one workflow command per finding at its line, with escaped properties", async () => {
    const report = await analyzeSql("db/a,b.sql", "\nDROP TABLE t;\nALTER TYPE r ADD VALUE 'x';", { hasDownMigration: true });
    expect(annotations([report])).toEqual([
      expect.stringMatching(/^::error file=db\/a%2Cb\.sql,line=2,title=HAZ-03 Irreversible data loss::Drops table "t"/),
      expect.stringMatching(/^::warning file=db\/a%2Cb\.sql,line=3,title=HAZ-05 Enum value added::/),
    ]);
    expect(annotations([report]).every((l) => !l.includes("\n"))).toBe(true);
  });
});

describe("commentBody", () => {
  it("stays under GitHub's comment size limit", async () => {
    const many = await analyzeSql("x.sql", Array.from({ length: 600 }, (_, i) => `DROP TABLE t${i};`).join("\n"), {
      hasDownMigration: true,
    });
    const body = commentBody([many], "abc");
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("report truncated");
    expect(body.startsWith(MARKER)).toBe(true);
  });
});
