CREATE TABLE IF NOT EXISTS "backtest_equity" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backtest_metrics" (
	"run_id" integer PRIMARY KEY NOT NULL,
	"total_return" double precision NOT NULL,
	"max_drawdown" double precision NOT NULL,
	"sharpe" double precision NOT NULL,
	"win_rate" double precision NOT NULL,
	"turnover" double precision NOT NULL,
	"num_trades" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(128),
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backtest_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"quantity" integer NOT NULL,
	"price" double precision NOT NULL,
	"fee" double precision NOT NULL,
	"tax" double precision NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bars" (
	"symbol" varchar(16) NOT NULL,
	"timeframe" varchar(8) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"adjusted" boolean DEFAULT false NOT NULL,
	"source" varchar(16) NOT NULL,
	CONSTRAINT "bars_symbol_timeframe_ts_pk" PRIMARY KEY("symbol","timeframe","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collector_state" (
	"source" varchar(16) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"timeframe" varchar(8) NOT NULL,
	"last_ts" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_state_source_symbol_timeframe_pk" PRIMARY KEY("source","symbol","timeframe")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"sentiment" real NOT NULL,
	"event_type" varchar(64),
	"confidence" real NOT NULL,
	"raw_output" jsonb NOT NULL,
	"model" varchar(64) NOT NULL,
	"prompt_version" varchar(16) NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" varchar(16),
	"source" varchar(16) NOT NULL,
	"event_type" varchar(64),
	"title" text NOT NULL,
	"body" text,
	"external_id" varchar(128),
	"published_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_order_id" varchar(64) NOT NULL,
	"broker_order_id" varchar(64),
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"quantity" integer NOT NULL,
	"price" double precision NOT NULL,
	"fee" double precision DEFAULT 0 NOT NULL,
	"tax" double precision DEFAULT 0 NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"broker_fill_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fundamentals" (
	"symbol" varchar(16) NOT NULL,
	"date" varchar(10) NOT NULL,
	"per" double precision,
	"pbr" double precision,
	"roe" double precision,
	"div" double precision,
	CONSTRAINT "fundamentals_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"client_order_id" varchar(64) PRIMARY KEY NOT NULL,
	"broker_order_id" varchar(64),
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"type" varchar(8) NOT NULL,
	"quantity" integer NOT NULL,
	"limit_price" double precision,
	"status" varchar(20) NOT NULL,
	"filled_quantity" integer DEFAULT 0 NOT NULL,
	"avg_fill_price" double precision,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"symbol" varchar(16) PRIMARY KEY NOT NULL,
	"quantity" integer NOT NULL,
	"avg_price" double precision NOT NULL,
	"high_water_mark" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_state" (
	"date" varchar(10) PRIMARY KEY NOT NULL,
	"start_equity" double precision,
	"daily_loss_pct" double precision DEFAULT 0 NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tick_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" varchar(16) NOT NULL,
	"intents_count" integer DEFAULT 0 NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"detail" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watchlist" (
	"date" varchar(10) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	"components" jsonb NOT NULL,
	CONSTRAINT "watchlist_date_symbol_pk" PRIMARY KEY("date","symbol")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bars_symbol_tf_ts_idx" ON "bars" USING btree ("symbol","timeframe","ts");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_source_external_idx" ON "events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_published_idx" ON "events" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_order_idx" ON "fills" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_broker_idx" ON "orders" USING btree ("broker_order_id");