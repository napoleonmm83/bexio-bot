CREATE TYPE "public"."invoice_run_status" AS ENUM('pending', 'creating', 'created', 'issuing', 'issued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recurring_interval" AS ENUM('monthly', 'quarterly', 'semi_annual', 'yearly');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bot_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"errors_jsonb" jsonb,
	"created_invoices_count" integer DEFAULT 0 NOT NULL,
	"sent_invoices_count" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_runs" (
	"order_id" integer NOT NULL,
	"billing_period" text NOT NULL,
	"invoice_id" integer,
	"status" "invoice_run_status" DEFAULT 'pending' NOT NULL,
	"lock_acquired_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error_jsonb" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_runs_order_id_billing_period_pk" PRIMARY KEY("order_id","billing_period")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_orders" (
	"bexio_order_id" integer PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"customer_name" text NOT NULL,
	"interval" "recurring_interval" NOT NULL,
	"expected_amount" text NOT NULL,
	"next_billing_date" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_runs_started_at_desc" ON "bot_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invoice_runs_status_lock" ON "invoice_runs" USING btree ("status","lock_acquired_at") WHERE status IN ('creating', 'issuing', 'sending');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recurring_orders_next_billing" ON "recurring_orders" USING btree ("next_billing_date") WHERE enabled = true;