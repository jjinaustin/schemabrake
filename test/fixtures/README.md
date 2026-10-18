These migrations are unedited tool output, not hand-written SQL.

- `prisma/migrations/*/migration.sql`: `prisma migrate diff --script` (Prisma 5.22.0), from empty to
  `source/v1.prisma`, then v1 → v2, v2 → v3 and v3 → v4.
- `drizzle/*.sql`: `drizzle-kit generate` (drizzle-kit 0.28.1), run once per schema version: the v1
  equivalent of `source/drizzle-schema-v2.ts` (users with `legacy`, `audit`, enum `role` = `user`),
  then `drizzle-schema-v2.ts`, `-v3.ts` and `-v4.ts`, answering "create" to every rename prompt.

v3 links invoices to users and drops the unique index on email; v4 makes that link required.

Neither tool needs a database to produce these. Regenerate them rather than editing them by hand,
and update the expected line numbers in `fixtures.test.ts` when you do.
