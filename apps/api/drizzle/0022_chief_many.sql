DROP INDEX "users_single_chief_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chief_since" timestamp with time zone;
--> statement-breakpoint
UPDATE "users" SET "chief_since" = "created_at" WHERE "chief";
