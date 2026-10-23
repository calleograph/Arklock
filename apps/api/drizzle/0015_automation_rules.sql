CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" text NOT NULL,
	"vault_id" uuid,
	"actor_circle_id" uuid,
	"notify_circles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notify_admins" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"fired" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_actor_circle_id_circles_id_fk" FOREIGN KEY ("actor_circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;