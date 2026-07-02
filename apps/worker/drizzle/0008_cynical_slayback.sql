CREATE TABLE IF NOT EXISTS "account_snapshots" (
	"ts" timestamp with time zone PRIMARY KEY DEFAULT now() NOT NULL,
	"equity" double precision NOT NULL,
	"cash" double precision NOT NULL
);
