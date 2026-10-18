import { describe, expect, it } from "vitest";
import { analyzeSql } from "../src/analyze.js";

/** Rule IDs found in plain SQL, with HAZ-06 off unless asked for (it depends on the filesystem). */
async function rules(sql: string, opts: { haz06?: boolean } = {}) {
  const r = await analyzeSql("m.sql", sql, { hasDownMigration: !opts.haz06 });
  expect(r.error).toBeUndefined();
  return r.findings.map((f) => f.rule);
}

describe("HAZ-01 index without CONCURRENTLY", () => {
  it("flags a plain and a unique index on an existing table", async () => {
    expect(await rules(`CREATE INDEX a ON t (c);`)).toEqual(["HAZ-01"]);
    expect(await rules(`CREATE UNIQUE INDEX a ON t (c);`)).toEqual(["HAZ-01"]);
  });
  it("passes CONCURRENTLY", async () => {
    expect(await rules(`CREATE INDEX CONCURRENTLY a ON t (c);`)).toEqual([]);
  });
  it("passes an index on a table created earlier in the same file", async () => {
    expect(await rules(`CREATE TABLE t (c int);\nCREATE INDEX a ON t (c);`)).toEqual([]);
  });
  it("treats an unqualified name and public.name as the same table", async () => {
    expect(await rules(`CREATE TABLE public.t (c int);\nCREATE INDEX a ON t (c);`)).toEqual([]);
  });
  it("still flags an index created before the table statement that follows it", async () => {
    expect(await rules(`CREATE INDEX a ON t (c);\nCREATE TABLE t2 (c int);`)).toEqual(["HAZ-01"]);
  });
  it("does not treat a same-named table in another schema as new", async () => {
    expect(await rules(`CREATE TABLE other.t (c int);\nCREATE INDEX a ON t (c);`)).toEqual(["HAZ-01"]);
  });
});

describe("HAZ-02 NOT NULL column without default", () => {
  it("flags NOT NULL with no default", async () => {
    expect(await rules(`ALTER TABLE t ADD COLUMN c text NOT NULL;`)).toEqual(["HAZ-02"]);
  });
  it("flags an inline PRIMARY KEY with no default", async () => {
    expect(await rules(`ALTER TABLE t ADD COLUMN c int PRIMARY KEY;`)).toEqual(["HAZ-02"]);
  });
  it.each([
    [`ALTER TABLE t ADD COLUMN c text NOT NULL DEFAULT 'x';`],
    [`ALTER TABLE t ADD COLUMN c text;`],
    [`ALTER TABLE t ADD COLUMN c serial NOT NULL;`],
    [`ALTER TABLE t ADD COLUMN c bigserial PRIMARY KEY;`],
    [`ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS IDENTITY;`],
    [`ALTER TABLE t ADD COLUMN c int NOT NULL GENERATED ALWAYS AS (1) STORED;`],
    [`CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN c text NOT NULL;`],
  ])("passes %s", async (sql) => {
    expect(await rules(sql)).toEqual([]);
  });
  it("reports each offending column of a multi-command ALTER on its own line", async () => {
    const r = await analyzeSql("m.sql", `ALTER TABLE t\nADD COLUMN a text NOT NULL,\nADD COLUMN b text,\nADD COLUMN c int NOT NULL;`, {
      hasDownMigration: true,
    });
    expect(r.findings.map((f) => [f.rule, f.line])).toEqual([
      ["HAZ-02", 2],
      ["HAZ-02", 4],
    ]);
  });
});

describe("HAZ-03 data loss", () => {
  it("flags DROP COLUMN and DROP TABLE", async () => {
    expect(await rules(`ALTER TABLE t DROP COLUMN c;`)).toEqual(["HAZ-03"]);
    expect(await rules(`DROP TABLE t;`)).toEqual(["HAZ-03"]);
  });
  it("flags each table of a multi-table DROP", async () => {
    expect(await rules(`DROP TABLE a, b;`)).toEqual(["HAZ-03", "HAZ-03"]);
  });
  it("mentions CASCADE", async () => {
    const r = await analyzeSql("m.sql", `DROP TABLE t CASCADE;`, { hasDownMigration: true });
    expect(r.findings[0].message).toContain("CASCADE");
  });
  it("passes dropping a table created earlier in the same file", async () => {
    expect(await rules(`CREATE TABLE tmp (c int);\nDROP TABLE tmp;`)).toEqual([]);
  });
  it("ignores dropping indexes and views", async () => {
    expect(await rules(`DROP INDEX i;\nDROP VIEW v;`)).toEqual([]);
  });
});

describe("HAZ-04 column type change", () => {
  it("flags ALTER COLUMN TYPE in both spellings", async () => {
    expect(await rules(`ALTER TABLE t ALTER COLUMN c TYPE bigint;`)).toEqual(["HAZ-04"]);
    expect(await rules(`ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint;`)).toEqual(["HAZ-04"]);
  });
});

describe("HAZ-05 enum value added", () => {
  it("flags ADD VALUE", async () => {
    expect(await rules(`ALTER TYPE role ADD VALUE 'admin';`)).toEqual(["HAZ-05"]);
  });
  it("names the line that uses the new value in the same file", async () => {
    const r = await analyzeSql(
      "m.sql",
      `ALTER TYPE role ADD VALUE 'admin';\n\nUPDATE users SET role = 'admin' WHERE id = 1;`,
      { hasDownMigration: true },
    );
    expect(r.findings[0].message).toContain("Line 3 of this file uses 'admin'");
  });
  it("passes RENAME VALUE", async () => {
    expect(await rules(`ALTER TYPE role RENAME VALUE 'a' TO 'b';`)).toEqual([]);
  });
});

describe("HAZ-06 no down migration", () => {
  it("is added only when the file has another hazard", async () => {
    expect(await rules(`CREATE TABLE t (c int);`, { haz06: true })).toEqual([]);
    expect(await rules(`DROP TABLE t;`, { haz06: true })).toEqual(["HAZ-03", "HAZ-06"]);
  });
  it("is not added when a down migration exists", async () => {
    expect(await rules(`DROP TABLE t;`)).toEqual(["HAZ-03"]);
  });
  it("warns that a down migration cannot restore dropped data only when data is dropped", async () => {
    const drop = await analyzeSql("m.sql", `DROP TABLE t;`, { hasDownMigration: false });
    const type = await analyzeSql("m.sql", `ALTER TABLE t ALTER COLUMN c TYPE bigint;`, { hasDownMigration: false });
    expect(drop.findings.at(-1)!.advice).toContain("cannot restore dropped data");
    expect(type.findings.at(-1)!.advice).not.toContain("cannot restore dropped data");
  });
});

describe("suppression", () => {
  it("ignores the named rule on the next statement only", async () => {
    const sql = `-- schemabrake-ignore HAZ-01\nCREATE INDEX a ON t (c);\nCREATE INDEX b ON t (c);`;
    const r = await analyzeSql("m.sql", sql, { hasDownMigration: true });
    expect(r.findings.map((f) => f.line)).toEqual([3]);
  });
  it("keeps other rules on an ignored statement", async () => {
    const sql = `-- schemabrake-ignore: HAZ-03\nALTER TABLE t DROP COLUMN a, ADD COLUMN b int NOT NULL;`;
    expect(await rules(sql)).toEqual(["HAZ-02"]);
  });
  it("ignores every rule when no ID is given", async () => {
    expect(await rules(`/* schemabrake-ignore */ DROP TABLE t;`)).toEqual([]);
  });
  it("ignores the whole file", async () => {
    expect(await rules(`-- schemabrake-ignore-file\nDROP TABLE t;\nCREATE INDEX a ON t (c);`, { haz06: true })).toEqual([]);
  });
  it("honours --disable", async () => {
    const r = await analyzeSql("m.sql", `DROP TABLE t;`, { disabled: new Set(["HAZ-03", "HAZ-06"]) });
    expect(r.findings).toEqual([]);
  });
});

describe("parsing", () => {
  it("counts lines in bytes-safe fashion after non-ASCII comments", async () => {
    const sql = `-- añadir índice 🚀🚀🚀\n-- second\n\nCREATE INDEX a ON t (c);`;
    const r = await analyzeSql("m.sql", sql, { hasDownMigration: true });
    expect(r.findings[0].line).toBe(4);
  });
  it("handles a last statement with no semicolon", async () => {
    const r = await analyzeSql("m.sql", `SELECT 1;\n\nDROP TABLE t`, { hasDownMigration: true });
    expect(r.findings.map((f) => [f.rule, f.line])).toEqual([["HAZ-03", 3]]);
  });
  it("reports a parse error with its line instead of throwing", async () => {
    const r = await analyzeSql("m.sql", `SELECT 1;\nCREATE TABLE (;`);
    expect(r.error?.line).toBe(2);
    expect(r.findings).toEqual([]);
  });
  it("does not look inside DO blocks", async () => {
    expect(await rules(`DO $$ BEGIN DROP TABLE t; END $$;`)).toEqual([]);
  });
});
