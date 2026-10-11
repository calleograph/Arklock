import type { ZodType } from 'zod';

/** Ожидаемая ошибка запроса: код и сообщение безопасны для показа клиенту. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = () => new AppError(404, 'not_found', 'Not found');
export const unauthorized = () => new AppError(401, 'unauthorized', 'Authentication required');
export const forbidden = () => new AppError(403, 'forbidden', 'Forbidden');

/** Строгая валидация входа. В ответ попадают только пути и коды ошибок, но не сами значения (там могут быть секреты). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new AppError(
    400,
    'validation_error',
    'Request validation failed',
    result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  );
}
