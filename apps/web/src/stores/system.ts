import { ref } from 'vue';
import { defineStore } from 'pinia';
import { API_PREFIX, readyResponse, versionResponse } from '@arklock/contracts';
import type { ReadyResponse, VersionResponse } from '@arklock/contracts';

export const useSystemStore = defineStore('system', () => {
  const version = ref<VersionResponse | null>(null);
  const ready = ref<ReadyResponse | null>(null);
  const loading = ref(false);
  const unreachable = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    unreachable.value = false;
    try {
      const [v, r] = await Promise.all([
        fetch(`${API_PREFIX}/version`),
        fetch(`${API_PREFIX}/ready`),
      ]);
      version.value = versionResponse.parse(await v.json());
      ready.value = readyResponse.parse(await r.json());
    } catch {
      unreachable.value = true;
    } finally {
      loading.value = false;
    }
  }

  return { version, ready, loading, unreachable, load };
});
