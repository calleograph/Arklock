CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"wrapped_key" text NOT NULL,
	"meta_cipher" text NOT NULL,
	"key_version" integer NOT NULL,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"parent_id" uuid,
	"name_cipher" text NOT NULL,
	"key_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"trash_group" uuid,
	"deleted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "circle_members" (
	"circle_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "circle_members_circle_id_user_id_pk" PRIMARY KEY("circle_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "circles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"branch_id" uuid,
	"wrapped_entry_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trash_group" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entry_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_entry_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ciphertext" text NOT NULL,
	"has_passphrase" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_views" integer NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"enc_public" text NOT NULL,
	"sign_public" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	CONSTRAINT "pins_user_id_entry_id_pk" PRIMARY KEY("user_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"reported_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"kdf" jsonb NOT NULL,
	"kdf_salt" text NOT NULL,
	"auth_salt" text NOT NULL,
	"auth_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_public_key" text NOT NULL,
	"wrapped_private_key" text NOT NULL,
	"wrapped_sign_private_key" text NOT NULL,
	"recovery_salt" text NOT NULL,
	"recovery_hash" text NOT NULL,
	"recovery_wrapped_private_key" text NOT NULL,
	"recovery_wrapped_sign_private_key" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_circles" (
	"vault_id" uuid NOT NULL,
	"circle_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "vault_circles_vault_id_circle_id_pk" PRIMARY KEY("vault_id","circle_id")
);
--> statement-breakpoint
CREATE TABLE "vault_keys" (
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"sealed_key" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_keys_vault_id_user_id_key_version_pk" PRIMARY KEY("vault_id","user_id","key_version")
);
--> statement-breakpoint
CREATE TABLE "vault_members" (
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_members_vault_id_user_id_pk" PRIMARY KEY("vault_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_circles" ADD CONSTRAINT "vault_circles_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_circles" ADD CONSTRAINT "vault_circles_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_members" ADD CONSTRAINT "vault_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entry_idx" ON "attachments" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "attachments_vault_idx" ON "attachments" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "branches_vault_idx" ON "branches" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "circle_members_user_idx" ON "circle_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "circles_name_idx" ON "circles" USING btree ("name");--> statement-breakpoint
CREATE INDEX "entries_vault_idx" ON "entries" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "entries_branch_idx" ON "entries" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "entry_revisions_entry_idx" ON "entry_revisions" USING btree ("entry_id","version");--> statement-breakpoint
CREATE INDEX "grants_vault_idx" ON "grants" USING btree ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_unique_idx" ON "grants" USING btree ("target_type","target_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "handoffs_user_idx" ON "handoffs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "key_log_user_idx" ON "key_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ledger_at_idx" ON "ledger" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signals_vault_idx" ON "signals" USING btree ("vault_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_entry_type_idx" ON "signals" USING btree ("entry_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "vault_members_user_idx" ON "vault_members" USING btree ("user_id");