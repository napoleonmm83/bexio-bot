CREATE TYPE "public"."bexio_status" AS ENUM('open', 'partial', 'done', 'canceled', 'unknown');--> statement-breakpoint
DROP INDEX IF EXISTS "idx_recurring_orders_next_billing";--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD COLUMN "bexio_status" "bexio_status" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD COLUMN "bexio_status_id" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recurring_orders_next_billing" ON "recurring_orders" USING btree ("next_billing_date") WHERE enabled = true AND bexio_status IN ('open', 'partial');