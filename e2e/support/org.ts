import type { Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_KDF } from '@arklock/crypto';
import { TestClient } from '../../apps/api/test/helpers.js';

/** HTTP вместо app.inject: те же клиентские ключи, что у браузера, но запросы идут к настоящему серверу e2e. */
export const httpApp = (base: string) =>
  ({
    async inject(o: {
      method?: string;
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }) {
      const r = await fetch(base + o.url, {
        method: o.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...o.headers },
        body: o.payload !== undefined ? JSON.stringify(o.payload) : undefined,
      });
      const body = await r.text();
      return { statusCode: r.status, body, json: () => JSON.parse(body) };
    },
  }) as unknown as FastifyInstance;

export const DEPARTMENTS = [
  'Руководство',
  'Секретариат',
  'ИТ',
  'Информационная безопасность',
  'Бухгалтерия',
  'Финансы',
  'Кадры',
  'Юридический отдел',
  'Маркетинг',
  'Продажи',
  'Логистика',
  'Закупки',
  'Склад',
  'Производство',
  'Клиентская поддержка',
  'Проектный офис',
  'Аналитика',
  'Разработка',
  'Техническая поддержка',
  'Административно-хозяйственный отдел',
];

export const PASSWORD = 'enterprise-test-password-1';
export const headEmail = (i: number) => `head${String(i + 1).padStart(2, '0')}@corp.example`;
export const staffEmail = (n: number) => `staff${String(n + 1).padStart(2, '0')}@corp.example`;

/** Регистрирует синтетических сотрудников через API с настоящими параметрами KDF. */
export async function seedUsers(base: string, count: number, email: (n: number) => string) {
  const out: TestClient[] = [];
  for (let n = 0; n < count; n++) {
    const c = new TestClient(httpApp(base), email(n), PASSWORD);
    const res = await c.register(undefined, DEFAULT_KDF);
    if (res.statusCode !== 201)
      throw new Error(`register ${email(n)}: ${res.statusCode} ${res.body}`);
    out.push(c);
  }
  return out;
}

/** Подсчёт действий пользователя: клик, ввод, выбор — по одному; экран — смена раздела или окна. */
export class Counter {
  clicks = 0;
  inputs = 0;
  screens = 0;
  private t0 = Date.now();
  constructor(
    readonly page: Page,
    readonly label: string,
  ) {}
  async click(testid: string) {
    this.clicks++;
    await this.page.getByTestId(testid).click();
  }
  async fill(testid: string, value: string) {
    this.inputs++;
    await this.page.getByTestId(testid).fill(value);
  }
  async pick(testid: string, value: string | { label: string }) {
    this.inputs++;
    await this.page.getByTestId(testid).selectOption(value);
  }
  screen() {
    this.screens++;
  }
  get actions() {
    return this.clicks + this.inputs;
  }
  get seconds() {
    return Math.round((Date.now() - this.t0) / 100) / 10;
  }
  report() {
    return `${this.label}: действий ${this.actions} (нажатий ${this.clicks}, вводов ${this.inputs}), экранов ${this.screens}, ${this.seconds} с`;
  }
}
