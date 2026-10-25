ALTER TABLE "vault_circles" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "managed_for" uuid;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_managed_for_users_id_fk" FOREIGN KEY ("managed_for") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;