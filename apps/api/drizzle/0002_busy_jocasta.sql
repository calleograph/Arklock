ALTER TABLE "invitations" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;