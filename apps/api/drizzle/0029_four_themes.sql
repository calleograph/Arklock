-- Четыре оформления вместо десяти: прежние схемы переносятся на ближайшее новое, неизвестное сбрасывается к теме по умолчанию.
UPDATE "users" SET "theme" = CASE "theme"
  WHEN 'corporate' THEN 'glass' WHEN 'sunset' THEN 'glass'
  WHEN 'light' THEN 'grove' WHEN 'emerald' THEN 'grove'
  WHEN 'dark' THEN 'night' WHEN 'forest' THEN 'night'
  ELSE "theme" END
WHERE "theme" IN ('corporate', 'sunset', 'light', 'emerald', 'dark', 'forest');
--> statement-breakpoint
UPDATE "users" SET "theme" = NULL WHERE "theme" IS NOT NULL AND "theme" NOT IN ('glass', 'night', 'grove', 'aurora');
--> statement-breakpoint
UPDATE "settings" SET "value" = to_jsonb(CASE "value" #>> '{}'
  WHEN 'corporate' THEN 'glass' WHEN 'sunset' THEN 'glass'
  WHEN 'light' THEN 'grove' WHEN 'emerald' THEN 'grove'
  WHEN 'dark' THEN 'night' WHEN 'forest' THEN 'night'
  ELSE 'glass' END)
WHERE "key" = 'appearance.defaultTheme' AND ("value" #>> '{}') NOT IN ('glass', 'night', 'grove', 'aurora');
