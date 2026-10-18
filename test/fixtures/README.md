These migrations are unedited tool output, not hand-written SQL.

- `prisma/migrations/*/migration.sql`: `prisma migrate diff --script` (Prisma 5.22.0), from empty to
  `source/v1.prisma`, then from `source/v1.prisma` to `source/v2.prisma`.
- `drizzle/*.sql`: `drizzle-kit generate` (drizzle-kit 0.28.1), first with the v1 equivalent of
  `source/drizzle-schema-v2.ts` (users with `legacy`, `audit`, enum `role` = `user`), then with v2,
  answering "create" to every rename prompt.

Neither tool needs a database to produce these. Regenerate them rather than editing them by hand,
and update the expected line numbers in `fixtures.test.ts` when you do.
