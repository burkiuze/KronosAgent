import { useEffect, useSyncExternalStore } from 'react';
import { get, patch } from './api';
import { applyTheme, type ColorMode } from './themes';
import { toast, useStore } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Config = Record<string, any>;

let config: Config | undefined;
let sections: { id: string; title: string; keys: string[]; description: string }[] = [];
let personalities: { id: string; label: string }[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function emit() {
  listeners.forEach((l) => l());
}

export async function loadConfig(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await get<{ config: Config; sections: typeof sections; personalities: typeof personalities }>('/api/config');
      config = r.config;
      sections = r.sections;
      personalities = r.personalities ?? [];
      const ui = config.ui ?? {};
      applyTheme(ui.theme ?? 'kronos', (ui.mode as ColorMode) ?? 'system', { fontSize: ui.fontSize, density: ui.density });
      emit();
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

function deepMerge(a: Config, b: Config): Config {
  const out: Config = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

/** Optimistically apply a config patch and persist it. */
export async function updateConfig(p: Config, quiet = false): Promise<void> {
  if (config) {
    config = deepMerge(config, p);
    const ui = config.ui ?? {};
    if (p.ui) applyTheme(ui.theme ?? 'kronos', ui.mode ?? 'system', { fontSize: ui.fontSize, density: ui.density });
    emit();
  }
  try {
    const r = await patch<{ config: Config }>('/api/config', p);
    config = r.config;
    emit();
    if (!quiet) toast('Saved', 'ok');
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`, 'error');
    void loadConfig();
  }
}

export function useConfig(): { config?: Config; sections: typeof sections; personalities: typeof personalities } {
  const version = useStore((s) => s.configVersion);
  useEffect(() => {
    void loadConfig();
  }, [version]);
  const c = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => config,
  );
  return { config: c, sections, personalities };
}

export function getConfig(): Config | undefined {
  return config;
}

export function cfgGet(path: string, c: Config | undefined = config): any {
  return path.split('.').reduce<any>((o, k) => (o === undefined || o === null ? undefined : o[k]), c);
}

export function pathPatch(path: string, value: unknown): Config {
  const keys = path.split('.');
  const out: Config = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      cur[k] = {};
      cur = cur[k];
    }
  });
  return out;
}
