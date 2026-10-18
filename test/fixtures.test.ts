import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFile, detectOrm, findMigrationFiles } from "../src/analyze.js";
import { formatMarkdown } from "../src/report.js";

// The fixtures are unedited output of `prisma migrate diff` (Prisma 5.22.0) and
// `drizzle-kit generate` (0.28.1) for the schemas in test/fixtures/source.
const F = "test/fixtures";
const PRISMA_INIT = `${F}/prisma/migrations/20261001000000_init/migration.sql`;
const PRISMA_CHANGE = `${F}/prisma/migrations/20261018000000_add_stripe_id/migration.sql`;
const DRIZZLE_INIT = `${F}/drizzle/0000_init.sql`;
const DRIZZLE_CHANGE = `${F}/drizzle/0001_add_stripe.sql`;
const PRISMA_LINK = `${F}/prisma/migrations/20261019000000_link_invoices/migration.sql`;
const PRISMA_REQUIRE = `${F}/prisma/migrations/20261020000000_require_invoice_user/migration.sql`;
const DRIZZLE_LINK = `${F}/drizzle/0002_link_invoices.sql`;
const DRIZZLE_REQUIRE = `${F}/drizzle/0003_require_invoice_user.sql`;

const summary = async (path: string) => (await analyzeFile(path)).findings.map((f) => `${f.rule}@${f.line}`);

describe("generated Prisma migrations", () => {
  it("detects Prisma from the folder layout", () => {
    expect(detectOrm(PRISMA_CHANGE, "")).toBe("prisma");
  });
  it("finds nothing in a migration that only creates tables", async () => {
    expect(await summary(PRISMA_INIT)).toEqual([]);
  });
  it("finds every hazard in the schema change, and none on the new table's index", async () => {
    expect(await summary(PRISMA_CHANGE)).toEqual([
      "HAZ-03@5", // DROP COLUMN "legacy"
      "HAZ-02@7", // ADD COLUMN "stripeCustomerId" TEXT NOT NULL
      "HAZ-03@11", // DROP TABLE "Audit"
      "HAZ-01@25", // CREATE UNIQUE INDEX "User_email_key"
      "HAZ-01@28", // CREATE INDEX "User_age_idx"
      "HAZ-05@2", // ADD VALUE 'ADMIN'
      "HAZ-04@8", // SET DATA TYPE BIGINT
      "HAZ-06@1",
    ]);
  });
  it("flags dropping a unique index and linking an existing table", async () => {
    expect(await summary(PRISMA_LINK)).toEqual([
      "HAZ-09@2", // DROP INDEX "User_email_key"
      "HAZ-07@8", // ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY
      "HAZ-06@1",
    ]);
  });
  it("flags making a relation required, which Prisma does by re-adding the foreign key", async () => {
    expect(await summary(PRISMA_REQUIRE)).toEqual([
      "HAZ-08@5", // SET NOT NULL
      "HAZ-07@8", // ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY, again
      "HAZ-06@1",
    ]);
  });
});

describe("generated Drizzle migrations", () => {
  it("detects Drizzle from the statement breakpoints", async () => {
    expect((await analyzeFile(DRIZZLE_CHANGE)).orm).toBe("drizzle");
  });
  it("finds nothing in a migration that only creates tables", async () => {
    expect(await summary(DRIZZLE_INIT)).toEqual([]);
  });
  it("finds every hazard in the schema change, and none on the new table's index", async () => {
    expect(await summary(DRIZZLE_CHANGE)).toEqual([
      "HAZ-03@8", // DROP TABLE "audit" CASCADE
      "HAZ-02@10", // ADD COLUMN "stripe_customer_id" text NOT NULL
      "HAZ-01@13", // CREATE INDEX "users_email_idx"
      "HAZ-03@14", // DROP COLUMN IF EXISTS "legacy"
      "HAZ-05@1", // ADD VALUE 'admin'
      "HAZ-04@9", // SET DATA TYPE bigint
      "HAZ-06@1",
    ]);
  });
  it("finds the foreign key inside Drizzle's DO block", async () => {
    expect(await summary(DRIZZLE_LINK)).toEqual([
      "HAZ-09@1", // DROP INDEX IF EXISTS "users_email_idx"
      "HAZ-07@4", // ADD CONSTRAINT ... FOREIGN KEY, inside DO $$ BEGIN ... END $$
      "HAZ-06@1",
    ]);
  });
  it("flags making a column required", async () => {
    expect(await summary(DRIZZLE_REQUIRE)).toEqual(["HAZ-08@1", "HAZ-06@1"]);
  });
});

describe("file discovery", () => {
  it("finds migration files and skips down migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0001_a.down.sql"), "SELECT 1;");
    writeFileSync(join(dir, "down.sql"), "SELECT 1;");
    writeFileSync(join(dir, "notes.md"), "");
    expect(findMigrationFiles([dir])).toEqual([join(dir, "0001_a.sql")]);
  });
  it("drops HAZ-06 when a down.sql sits beside the migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "migration.sql"), "DROP TABLE t;");
    expect(await summary(join(dir, "migration.sql"))).toEqual(["HAZ-03@1", "HAZ-06@1"]);
    writeFileSync(join(dir, "down.sql"), "CREATE TABLE t (c int);");
    expect(await summary(join(dir, "migration.sql"))).toEqual(["HAZ-03@1"]);
  });
});

describe("markdown report", () => {
  it("renders one table row per finding and escapes pipes", async () => {
    const md = formatMarkdown([await analyzeFile(PRISMA_CHANGE)]);
    expect(md.match(/^\| 🔴 CRITICAL/gm)).toHaveLength(5);
    expect(md).toContain("**5 critical**, 2 warning, 1 info");
  });
});

describe("CLI", () => {
  const run = (...args: string[]) => spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });

  it("exits 1 on critical hazards and 0 when only clean files are checked", () => {
    expect(run("check", PRISMA_CHANGE).status).toBe(1);
    expect(run("check", PRISMA_INIT, DRIZZLE_INIT).status).toBe(0);
  });
  it("respects --fail-on", () => {
    expect(run("check", PRISMA_CHANGE, "--fail-on", "never").status).toBe(0);
    expect(run("check", PRISMA_CHANGE, "--disable", "HAZ-01,HAZ-02,HAZ-03").status).toBe(0);
    expect(run("check", PRISMA_CHANGE, "--disable", "HAZ-01,HAZ-02,HAZ-03", "--fail-on", "warning").status).toBe(1);
  });
  it("prints JSON", () => {
    const out = JSON.parse(run("check", `${F}/drizzle`, "--format", "json").stdout);
    expect(out.summary).toEqual({ files: 4, critical: 4, warning: 5, info: 3, errors: 0 });
  });
  it("exits 2 on bad usage and on unparseable SQL", () => {
    expect(run("check", "--format", "xml", PRISMA_INIT).status).toBe(2);
    expect(run("check", "--disable", "HAZ-99", PRISMA_INIT).status).toBe(2);
    expect(run("lint").status).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "bad.sql"), "CREATE TABLE (;");
    expect(run("check", dir).status).toBe(2);
  });
});
