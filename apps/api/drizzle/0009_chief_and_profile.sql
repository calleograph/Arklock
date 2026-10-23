ALTER TABLE "users" ADD COLUMN "chief" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_source" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_chief_idx" ON "users" USING btree ("chief") WHERE "users"."chief";--> statement-breakpoint
-- главным администратором становится самый ранний активный полный администратор
UPDATE "users" SET "chief" = true WHERE "id" = (SELECT "id" FROM "users" WHERE "role" = 'admin' AND "disabled_at" IS NULL ORDER BY "created_at", "id" LIMIT 1);
