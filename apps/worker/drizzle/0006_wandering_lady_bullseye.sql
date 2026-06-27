CREATE TABLE IF NOT EXISTS "control_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"requested_by" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "tick_runs" ADD COLUMN "equity" double precision;--> statement-breakpoint
ALTER TABLE "tick_runs" ADD COLUMN "cash" double precision;