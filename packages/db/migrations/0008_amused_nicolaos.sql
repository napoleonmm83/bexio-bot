CREATE TABLE IF NOT EXISTS "tvr_tool_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tvr_tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tool" text NOT NULL,
	"caller" text,
	"input_jsonb" jsonb NOT NULL,
	"result_jsonb" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tvr_tool_calls_called_at" ON "tvr_tool_calls" USING btree ("called_at");