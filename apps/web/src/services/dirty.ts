import { computed, ref } from 'vue';

/**
 * Признак «есть несохранённые изменения» для форм с кнопкой «Сохранить»: сравнивает текущее состояние формы с
 * состоянием на момент clean() (после загрузки или сохранения). Пока clean() не вызван, изменений нет.
 */
export function useDirty(source: () => unknown) {
  const snap = () => JSON.stringify(source() ?? null);
  const base = ref<string | null>(null);
  const dirty = computed(() => base.value !== null && snap() !== base.value);
  return {
    dirty,
    clean: () => (base.value = snap()),
    reset: () => (base.value = null),
  };
}
