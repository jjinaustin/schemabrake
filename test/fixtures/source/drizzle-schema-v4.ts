import { pgTable, pgEnum, serial, text, integer, bigint, index } from "drizzle-orm/pg-core";
export const role = pgEnum("role", ["user", "admin"]);
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  age: bigint("age", { mode: "number" }).notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  plan: text("plan").default("free").notNull(),
  role: role("role").default("user").notNull(),
});
export const invoices = pgTable("invoices", {
  id: integer("id").primaryKey(),
  total: integer("total").notNull(),
  userId: integer("user_id").notNull().references(() => users.id),
}, (t) => ({ totalIdx: index("invoices_total_idx").on(t.total) }));
