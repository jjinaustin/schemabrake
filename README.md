# SchemaBrake

Catches PostgreSQL migrations that will lock a table or lose data before they reach production.
SchemaBrake reads the SQL that Prisma and Drizzle generate, parses it with PostgreSQL's own parser
(libpg_query, compiled to WebAssembly), and never connects to a database.

```
npx schemabrake check prisma/migrations
```

With no paths it checks `./prisma/migrations` and `./drizzle`.

## GitHub Action

```yaml
# .github/workflows/migrations.yml
name: migrations
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  schemabrake:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jjinaustin/schemabrake@main
```

The action checks only the migration files the pull request adds or changes, read from the
GitHub API, so the checkout needs no history. It posts one comment with the report and edits that
same comment on every later push. It also annotates each hazard on its line in the diff, writes
the report to the job summary, and fails the check on critical findings.

| Input | Default | |
| --- | --- | --- |
| `paths` | Prisma and Drizzle locations | Directories to check instead, one per line, e.g. `supabase/migrations` |
| `fail-on` | `critical` | `critical`, `warning`, `info` or `never` |
| `disable` | | Rule IDs to skip, e.g. `HAZ-06` |
| `comment` | `true` | `false` to annotate and summarize without commenting |
| `github-token` | `github.token` | |

Outputs: `files`, `critical`, `warning`, `info`.

Pull requests from forks get a read-only token, so the comment is skipped with a warning; the
annotations, job summary and pass/fail still work. Avoid an `on.pull_request.paths` filter if
the check is required: a pull request that doesn't match it leaves the required check pending,
and one that stops touching migrations leaves the old comment in place.

The runner needs Node 18.18 or later; GitHub-hosted runners have it.

## Rules

| ID | Severity | Flags | Why |
| --- | --- | --- | --- |
| HAZ-01 | critical | `CREATE [UNIQUE] INDEX` without `CONCURRENTLY` | Holds a SHARE lock: writes to the table wait for the whole build. |
| HAZ-02 | critical | `ADD COLUMN ... NOT NULL` (or inline `PRIMARY KEY`) with no default | Fails on a non-empty table; otherwise the previous release's INSERTs fail. |
| HAZ-03 | critical | `DROP COLUMN`, `DROP TABLE` | Data is gone; the previous release still queries it. Prisma renames show up as drop + add. |
| HAZ-04 | warning | `ALTER COLUMN ... TYPE` | ACCESS EXCLUSIVE lock, usually a full table rewrite. |
| HAZ-05 | warning | `ALTER TYPE ... ADD VALUE` | Can't run in a transaction before PG 12; the value can't be used in the same transaction after. |
| HAZ-06 | info | A file with any other finding and no `down.sql` / `<name>.down.sql` beside it | Neither ORM generates down migrations. |
| HAZ-07 | warning | `ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID`, or validated in the same file | Checks every row while blocking writes to both tables. Prisma re-adds the key whenever a relation becomes required. |
| HAZ-08 | warning | `ALTER COLUMN ... SET NOT NULL` | ACCESS EXCLUSIVE lock while every row is scanned for NULLs. |
| HAZ-09 | warning | `DROP INDEX` without `CONCURRENTLY` | Brief ACCESS EXCLUSIVE lock, but it queues behind running queries and everything queues behind it. |

Statements on a table or index created earlier in the same file are not flagged: nothing is reading
it yet. Statements inside a `DO $$ BEGIN ... [EXCEPTION ...] END $$` block, the wrapper Drizzle puts
around every foreign key, are checked like any other.
Every finding carries remediation written for the ORM that generated the file.

## Options

```
--format <text|markdown|json>           default text; markdown is the PR-comment format
--fail-on <critical|warning|info|never> lowest severity that exits 1 (default critical)
--disable <HAZ-xx,...>                  skip rules
--orm <prisma|drizzle|sql>              override detection
```

Exit codes: `0` clean, `1` failing hazards, `2` usage error or SQL that does not parse.

Suppress a finding with a comment directly above the statement:

```sql
-- schemabrake-ignore HAZ-01: table has 40 rows
CREATE INDEX "Flag_name_idx" ON "Flag"("name");
```

`-- schemabrake-ignore` with no ID suppresses every rule for that statement;
`-- schemabrake-ignore-file` anywhere in a file skips it.

## Limits

- `DO` blocks with variables, control flow or `EXECUTE` are not inspected; only a plain
  `BEGIN <statements> [EXCEPTION ...] END` body is.
- HAZ-04 cannot tell a binary-compatible change (e.g. `varchar(50)` to `text`) from a rewrite
  without the old type, so it warns on both.
- HAZ-08 does not notice a validated `CHECK (col IS NOT NULL)` that makes the scan unnecessary;
  suppress it with an ignore comment when you have one.
- No rule yet for `ADD CONSTRAINT ... CHECK` or `UNIQUE` without `NOT VALID` / `USING INDEX`, or for a
  `FOREIGN KEY` declared inline in `ADD COLUMN ... REFERENCES`.

## Development

```
npm install
npm test        # tsc + vitest; fixtures are real Prisma and Drizzle output (see test/fixtures)
```
