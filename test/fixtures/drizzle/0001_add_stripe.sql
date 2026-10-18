ALTER TYPE "public"."role" ADD VALUE 'admin';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" integer PRIMARY KEY NOT NULL,
	"total" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "audit" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "age" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_total_idx" ON "invoices" USING btree ("total");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "legacy";