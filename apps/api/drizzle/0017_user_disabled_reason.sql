ALTER TABLE "users" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_by" uuid;