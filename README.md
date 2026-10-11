# Arklock

Корпоративный менеджер паролей с открытым исходным кодом: сквозное шифрование на стороне клиента, общие хранилища, роли и аудит, развёртывание в Docker, обновление из веб-интерфейса.

> **Статус: ранний прототип (0.1.0), этап 2.** Работают регистрация, вход, сессии, мастер-пароль с клиентским шифрованием, ключ восстановления и личный сейф с записями (проверено автотестами и сквозными тестами в браузере). Общие хранилища, роли, корпоративный вход, администрирование и обновление из интерфейса — следующие этапы (см. [PROJECT.md](PROJECT.md)). **Не используйте для хранения реальных секретов:** криптографическая архитектура не проходила независимую проверку.

## Быстрый старт (разработка)

Требуется Node.js 24+.

```bash
npm ci
npm run build
APP_SECRET=$(openssl rand -base64 48) DATABASE_URL=pglite:memory WEB_DIST=apps/web/dist PORT=8080 node apps/api/dist/main.js
# http://127.0.0.1:8080
```

Проверки: `npm run format:check && npm run lint && npm run typecheck && npm test`; сквозные тесты в браузере: `npx playwright install chromium && npm run test:e2e`.

## Docker

> Файлы контейнерной сборки подготовлены, но **ещё не проверены запуском**: Docker на машине разработки недоступен, проверка выполняется в CI.

```bash
cp .env.example .env      # задайте POSTGRES_PASSWORD и APP_SECRET
docker compose up -d --build --wait
curl http://127.0.0.1:8080/api/v1/ready
```

Порт публикуется только на loopback — для доступа по сети поставьте reverse proxy с HTTPS.

## Документация

- [PROJECT.md](PROJECT.md) — текущее состояние, [HISTORY.md](HISTORY.md) — журнал, [CHANGELOG.md](CHANGELOG.md)
- [docs/architecture](docs/architecture), [docs/security](docs/security), [docs/deployment](docs/deployment)
- [SECURITY.md](SECURITY.md) — как сообщить об уязвимости

## Лицензия

Лицензия ещё не выбрана (рассматриваются Apache-2.0 и AGPL-3.0). До её добавления права на использование и распространение не предоставлены. Продукт задуман полностью бесплатным: без платных редакций, лицензионных ключей и искусственных ограничений.
