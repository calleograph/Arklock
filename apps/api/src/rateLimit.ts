/** Ограничитель попыток в скользящем окне (в памяти процесса; для нескольких экземпляров — вынести в БД). */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string): number[] {
    const t = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > t);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Секунд до разблокировки, 0 — попытки разрешены. */
  retryAfter(key: string): number {
    const list = this.prune(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil(((list[0] ?? 0) + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
