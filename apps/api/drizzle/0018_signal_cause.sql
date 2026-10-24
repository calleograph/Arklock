ALTER TABLE "signals" ADD COLUMN "cause_user_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_cause_user_id_users_id_fk" FOREIGN KEY ("cause_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- события «смените пароль», созданные до 1.45: уволенный сотрудник — из записи журнала signal.create (последней по событию)
UPDATE "signals" AS s SET "cause_user_id" = c."uid"
FROM (
  SELECT DISTINCT ON (l."target") l."target", (l."detail"->>'user')::uuid AS "uid"
  FROM "ledger" AS l
  WHERE l."action" = 'signal.create'
    AND l."detail"->>'reason' = 'offboarding'
    AND l."detail"->>'user' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY l."target", l."id" DESC
) AS c
WHERE s."type" = 'rotate'
  AND s."cause_user_id" IS NULL
  AND c."target" = 'signal:' || s."id"::text
  AND c."uid" IN (SELECT "id" FROM "users");
