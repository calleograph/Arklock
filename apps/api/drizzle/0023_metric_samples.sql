CREATE TABLE "metric_samples" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"cpu_pct" integer NOT NULL,
	"mem_pct" integer NOT NULL,
	"disk_pct" integer NOT NULL,
	"db_bytes" bigint NOT NULL
);
