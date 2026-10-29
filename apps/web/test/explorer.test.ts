import { describe, expect, it } from 'vitest';
import { childIndex, trailOf } from '../src/services/explorer';
import type { BranchItem } from '../src/services/model';

const b = (id: string, parentId: string | null, name = id): BranchItem => ({
  id,
  parentId,
  name,
  version: 1,
  access: 'manager',
  deletedAt: null,
});

describe('проводник: папки текущего расположения', () => {
  const all = [
    b('a', null, 'Серверы'),
    b('b', 'a', 'Linux'),
    b('c', 'b', 'Production'),
    b('d', null, 'Сеть'),
  ];

  it('делит папки по родителю и сортирует естественно', () => {
    const idx = childIndex([b('x10', null, 'Папка 10'), b('x2', null, 'Папка 2'), ...all]);
    expect(idx.get(null)!.map((f) => f.name)).toEqual(['Папка 2', 'Папка 10', 'Серверы', 'Сеть']);
    expect(idx.get('a')!.map((f) => f.id)).toEqual(['b']);
    expect(idx.get('c')).toBeUndefined();
  });

  it('путь идёт от верхней папки до выбранной', () => {
    expect(trailOf(all, 'c').map((f) => f.name)).toEqual(['Серверы', 'Linux', 'Production']);
    expect(trailOf(all, null)).toEqual([]);
    expect(trailOf(all, 'нет такой')).toEqual([]);
  });

  it('недоступный родитель не раскрывается: папка выше своего доступа становится корневой', () => {
    const visible = [b('b', 'скрыта', 'Linux'), b('c', 'b', 'Production')];
    expect(
      childIndex(visible)
        .get(null)!
        .map((f) => f.id),
    ).toEqual(['b']);
    expect(trailOf(visible, 'c').map((f) => f.name)).toEqual(['Linux', 'Production']);
  });

  it('цикл в данных не вешает построение пути', () => {
    expect(trailOf([b('p', 'q'), b('q', 'p')], 'p').length).toBeLessThanOrEqual(2);
  });

  it('600 папок и пять уровней строятся быстро', () => {
    const many: BranchItem[] = [];
    for (let i = 0; i < 600; i++)
      many.push(b(`f${i}`, i < 5 ? (i ? `f${i - 1}` : null) : `f${i % 5}`));
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      childIndex(many);
      trailOf(many, 'f4');
    }
    expect((performance.now() - t0) / 50).toBeLessThan(20);
    expect(trailOf(many, 'f4')).toHaveLength(5);
  });
});
