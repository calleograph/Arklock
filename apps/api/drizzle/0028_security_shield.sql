CREATE TABLE "captcha_used" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cidr" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "ip_rules_cidr_unique" UNIQUE("cidr")
);
--> statement-breakpoint
CREATE TABLE "security_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"rule" text NOT NULL,
	"strikes" integer DEFAULT 1 NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"released_at" timestamp with time zone,
	"released_by" text
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_id" text,
	"account" text,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"rule" text,
	"result" text NOT NULL,
	"seconds" integer,
	"source" text,
	"request_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_blocks_key_idx" ON "security_blocks" USING btree ("key","created_at");--> statement-breakpoint
CREATE INDEX "security_events_at_idx" ON "security_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "security_events_ip_idx" ON "security_events" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "security_events_kind_idx" ON "security_events" USING btree ("kind","at");