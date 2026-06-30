CREATE TABLE IF NOT EXISTS "sector_signals" (
	"date" varchar(10) NOT NULL,
	"sector" varchar(32) NOT NULL,
	"score" double precision NOT NULL,
	"rationale" text,
	"headline_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sector_signals_date_sector_pk" PRIMARY KEY("date","sector")
);
