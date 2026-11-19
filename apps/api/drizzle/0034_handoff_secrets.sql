CREATE TABLE "handoff_claims" (
	"handoff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	CONSTRAINT "handoff_claims_handoff_id_token_hash_pk" PRIMARY KEY("handoff_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "handoff_keys" (
	"handoff_id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "kind" text DEFAULT 'entry' NOT NULL;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "wrapped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "handoff_claims" ADD CONSTRAINT "handoff_claims_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_keys" ADD CONSTRAINT "handoff_keys_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE cascade ON UPDATE no action;