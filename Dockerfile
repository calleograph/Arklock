# syntax=docker/dockerfile:1
# Многоступенчатая сборка: зависимости и сборка — в build, в итоговом образе только продуктивные пакеты.
# Метаданные сборки (версия/commit/время) — в конце, чтобы их смена не сбрасывала кэш слоёв.

FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Сеть сборки бывает нестабильной: повторные попытки загрузки пакетов вместо немедленного отказа
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
RUN npm ci --no-audit --no-fund
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/arklock
COPY package.json package-lock.json ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/client/package.json packages/client/
COPY apps/cli/package.json apps/cli/
# Сеть сборки бывает нестабильной: повторные попытки загрузки пакетов вместо немедленного отказа
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000
RUN npm ci --omit=dev --no-audit --no-fund -w @arklock/api && npm cache clean --force
COPY --from=build /src/packages/crypto/dist packages/crypto/dist
COPY --from=build /src/packages/contracts/dist packages/contracts/dist
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/api/drizzle apps/api/drizzle
COPY --from=build /src/apps/web/dist web

ARG APP_VERSION=0.0.0
ARG APP_GIT_COMMIT=unknown
ARG APP_BUILT_AT=unknown
# Версия «запекается» в образ: она всегда соответствует работающему коду.
ENV APP_VERSION=${APP_VERSION} APP_GIT_COMMIT=${APP_GIT_COMMIT} APP_BUILT_AT=${APP_BUILT_AT} \
    WEB_DIST=/srv/arklock/web PORT=8080 HOST=0.0.0.0

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
