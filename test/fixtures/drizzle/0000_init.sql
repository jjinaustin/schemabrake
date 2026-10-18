CREATE TYPE "public"."role" AS ENUM('user');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"age" integer NOT NULL,
	"legacy" text,
	"role" "role" DEFAULT 'user' NOT NULL
);
