# Развёртывание

Установка, reverse proxy, резервное копирование и обновление из интерфейса реализованы: см. [docs/INSTALL.md](../INSTALL.md), [docs/UPDATE.md](../UPDATE.md), [docs/BACKUP_AND_RESTORE.md](../BACKUP_AND_RESTORE.md). Контейнерное развёртывание проверяется в CI (задачи `container`, `installer`, `shared-host`).

## Требования к reverse proxy

- Терминировать HTTPS; передавать `X-Forwarded-For` и `X-Forwarded-Proto`; `TRUSTED_PROXY_HOPS` равен числу прокси перед контейнером.
- Не публиковать порт приложения наружу напрямую (по умолчанию он привязан к 127.0.0.1).
