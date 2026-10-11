import { API_PREFIX } from '@arklock/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'arklock.token';
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Токен хранится в sessionStorage: живёт до закрытия вкладки и не доступен другим вкладкам. */
export function loadToken(): string | null {
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export function setToken(value: string | null): void {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* хранилище недоступно — токен только в памяти */
  }
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

let onMfaRequired: (() => void) | null = null;
export function setMfaRequiredHandler(fn: () => void): void {
  onMfaRequired = fn;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  Object.assign(headers, opts.headers);
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Network error');
  }
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    if (res.status === 401 && token && err?.code === 'unauthorized') onUnauthorized?.();
    if (res.status === 403 && err?.code === 'mfa_enrollment_required') onMfaRequired?.();
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return data as T;
}

/** Передача двоичных данных (зашифрованные вложения): тело — «как есть», ошибки приводятся к ApiError. */
export async function apiBinary(
  method: 'GET' | 'PUT',
  path: string,
  body?: Uint8Array,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/octet-stream';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Network error');
  }
  if (res.status === 204) return new Uint8Array();
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    if (res.status === 401 && token && data?.error?.code === 'unauthorized') onUnauthorized?.();
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'http_error',
      data?.error?.message ?? res.statusText,
      data?.error?.details,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}
