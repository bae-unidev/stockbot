CREATE TABLE IF NOT EXISTS "backtest_allocation" (
	"run_id" integer PRIMARY KEY NOT NULL,
	"series" jsonb NOT NULL
);
