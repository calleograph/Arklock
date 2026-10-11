# Архитектура (обзор)

Модульный монолит: один процесс API (Fastify) + SPA (Vue 3) + PostgreSQL. Подсистемы (в `apps/api/src`, по мере реализации): identity, access, vault, ledger/signals, admin, integrations, updates, backup, jobs.

Общие пакеты: `@arklock/crypto` (без зависимостей от сервера и UI), `@arklock/contracts` (схемы Zod).

Принципы: сервер хранит только шифртекст; версионируемый API (`/api/v1`); единый формат ошибок; строгая валидация; миграции Drizzle применяются при старте; `/health` (процесс жив) и `/ready` (БД доступна).
