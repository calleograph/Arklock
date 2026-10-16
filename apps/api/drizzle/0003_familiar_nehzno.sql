CREATE TABLE "corporate_recovery_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"nonce_hash" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "corporate_recovery_keys" (
	"vault_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"sealed_key" text NOT NULL,
	"signature" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_by_sign_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_recovery_keys_vault_id_recipient_id_key_version_pk" PRIMARY KEY("vault_id","recipient_id","key_version")
);
--> statement-breakpoint
ALTER TABLE "corporate_recovery_challenges" ADD CONSTRAINT "corporate_recovery_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_recovery_challenges" ADD CONSTRAINT "corporate_recovery_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_recovery_challenges" ADD CONSTRAINT "corporate_recovery_challenges_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_recovery_keys" ADD CONSTRAINT "corporate_recovery_keys_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_recovery_challenges_expiry_idx" ON "corporate_recovery_challenges" USING btree ("expires_at");