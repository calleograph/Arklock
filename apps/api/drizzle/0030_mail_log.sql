-- Журнал отправки: тип уведомления, профиль, идентификаторы письма и подробности последней ошибки.
ALTER TABLE "mail_queue" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "mail_queue" ADD COLUMN "profile_name" text;
--> statement-breakpoint
ALTER TABLE "mail_queue" ADD COLUMN "message_id" text;
--> statement-breakpoint
ALTER TABLE "mail_queue" ADD COLUMN "smtp_ref" text;
--> statement-breakpoint
ALTER TABLE "mail_queue" ADD COLUMN "last_stage" text;
--> statement-breakpoint
ALTER TABLE "mail_queue" ADD COLUMN "last_text" text;
