ALTER TABLE "signals" ADD COLUMN "cause_reason" text;--> statement-breakpoint
-- до 1.54 причину «смените пароль» давало только увольнение
UPDATE "signals" SET "cause_reason" = 'offboarding' WHERE "type" = 'rotate' AND "cause_user_id" IS NOT NULL AND "cause_reason" IS NULL;
