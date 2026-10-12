import { z } from 'zod';
import {
  entryDelete,
  entryRecord,
  entryUpdate,
  entryWrite,
  revisionRecord,
  vaultInfo,
} from '@arklock/contracts';

/**
 * Описание API для интеграций (OpenAPI 3.1): то, чем пользуются сервисные токены и консольный клиент.
 * Схемы запросов и ответов получены из тех же схем zod, по которым сервер проверяет запросы, поэтому расхождения
 * с реальным поведением невозможны; соответствие маршрутов проверяется тестом `openapi.test.ts`.
 *
 * Важно: токены не открывают данные. Записи приходят шифртекстом (`ciphertext`, `wrappedEntryKey`); расшифровка
 * выполняется на стороне клиента ключом хранилища (см. docs/security/audit-package.md и docs/CLI.md).
 */
const schema = (s: z.ZodType) => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(s, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  void _omit;
  return rest;
};

const errorResponse = {
  description: 'Ошибка',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string', examples: ['unauthorized', 'forbidden', 'token_read_only'] },
              message: { type: 'string' },
              requestId: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
};

const json = (s: unknown) => ({ 'application/json': { schema: s } });
const vaultId = {
  name: 'vaultId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const entryId = {
  name: 'entryId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const secured = [{ apiToken: [] }];
const errors = {
  '401': { ...errorResponse, description: 'Токен недействителен, просрочен или отозван' },
  '403': { ...errorResponse, description: 'Нет права на действие или токен только для чтения' },
};

export function buildOpenApi(version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Arklock API',
      version,
      description:
        'Интерфейс для интеграций и консольного клиента. Авторизация — токен API (`akt_…`), созданный в «Безопасность → Токены API» ' +
        '(только чтение либо чтение и запись, со сроком действия). Токены не открывают данные: содержимое записей зашифровано ключом ' +
        'хранилища, который есть только у участников. Любое изменение шифруется на стороне клиента.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/api/v1' }],
    security: secured,
    components: {
      securitySchemes: {
        apiToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Токен API: `Authorization: Bearer akt_…`. Сервер хранит только SHA-256 токена.',
        },
      },
      schemas: {
        VaultInfo: schema(vaultInfo),
        EntryWrite: schema(entryWrite),
        EntryUpdate: schema(entryUpdate),
        EntryDelete: schema(entryDelete),
        EntryRecord: schema(entryRecord),
        RevisionRecord: schema(revisionRecord),
      },
    },
    paths: {
      '/health': {
        get: {
          summary: 'Процесс жив',
          security: [],
          responses: { '200': { description: 'ok', content: json({ type: 'object' }) } },
        },
      },
      '/ready': {
        get: {
          summary: 'Готовность (доступна база данных)',
          security: [],
          responses: {
            '200': { description: 'готов', content: json({ type: 'object' }) },
            '503': errorResponse,
          },
        },
      },
      '/version': {
        get: {
          summary: 'Версия, сборка, канал обновлений',
          security: [],
          responses: { '200': { description: 'версия', content: json({ type: 'object' }) } },
        },
      },
      '/auth/me': {
        get: {
          summary: 'Владелец токена: профиль и зашифрованные ключи аккаунта',
          responses: {
            '200': { description: 'пользователь', content: json({ type: 'object' }) },
            ...errors,
          },
        },
      },
      '/vaults': {
        get: {
          summary: 'Хранилища пользователя с ролью, разрешениями и версией ключа',
          responses: {
            '200': {
              description: 'список',
              content: json({ type: 'array', items: { $ref: '#/components/schemas/VaultInfo' } }),
            },
            ...errors,
          },
        },
      },
      '/vaults/{vaultId}/tree': {
        get: {
          summary: 'Папки и записи хранилища, доступные пользователю (шифртекст)',
          parameters: [
            vaultId,
            {
              name: 'trash',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: '`1` — содержимое корзины',
            },
          ],
          responses: {
            '200': { description: 'дерево', content: json({ type: 'object' }) },
            ...errors,
          },
        },
      },
      '/vaults/{vaultId}/entries': {
        post: {
          summary: 'Создать запись (токен чтение и запись; содержимое шифруется клиентом)',
          parameters: [vaultId],
          requestBody: {
            required: true,
            content: json({ $ref: '#/components/schemas/EntryWrite' }),
          },
          responses: {
            '201': {
              description: 'создана',
              content: json({ $ref: '#/components/schemas/EntryRecord' }),
            },
            '409': {
              ...errorResponse,
              description: 'Версия ключа хранилища устарела (`stale_key_version`)',
            },
            ...errors,
          },
        },
      },
      '/vaults/{vaultId}/entries/{entryId}': {
        get: {
          summary: 'Запись (шифртекст)',
          parameters: [vaultId, entryId],
          responses: {
            '200': {
              description: 'запись',
              content: json({ $ref: '#/components/schemas/EntryRecord' }),
            },
            '404': errorResponse,
            ...errors,
          },
        },
        put: {
          summary: 'Изменить запись; `expectedVersion` защищает от потери чужой правки',
          parameters: [vaultId, entryId],
          requestBody: {
            required: true,
            content: json({ $ref: '#/components/schemas/EntryUpdate' }),
          },
          responses: {
            '200': {
              description: 'изменена',
              content: json({ $ref: '#/components/schemas/EntryRecord' }),
            },
            '409': {
              ...errorResponse,
              description:
                'Конфликт версий (`version_conflict`, в `details.currentVersion` — актуальная)',
            },
            ...errors,
          },
        },
        delete: {
          summary:
            'Переместить запись в корзину (`?expectedVersion=`) или удалить насовсем (`?purge=1`, запись уже в корзине)',
          parameters: [
            vaultId,
            entryId,
            {
              name: 'expectedVersion',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1 },
            },
            {
              name: 'purge',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
            },
          ],
          responses: { '204': { description: 'выполнено' }, '409': errorResponse, ...errors },
        },
      },
      '/vaults/{vaultId}/entries/{entryId}/revisions': {
        get: {
          summary: 'История изменений записи (шифртекст)',
          parameters: [vaultId, entryId],
          responses: {
            '200': {
              description: 'версии',
              content: json({
                type: 'array',
                items: { $ref: '#/components/schemas/RevisionRecord' },
              }),
            },
            ...errors,
          },
        },
      },
      '/key-log': {
        get: {
          summary: 'Журнал привязки открытых ключей (хэш-цепочка) для проверки выданных ключей',
          responses: {
            '200': { description: 'журнал', content: json({ type: 'array' }) },
            ...errors,
          },
        },
      },
    },
  };
}
