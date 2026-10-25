import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { defaultConfig, type KronosConfig } from './schema.js';
import { deepMerge, getPath, isPlainObject, setPath } from '../util/misc.js';
import { expandEnvDeep, loadDotenv } from '../util/env.js';

export function readYamlFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const parsed = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  return isPlainObject(parsed) ? parsed : {};
}

export function writeYamlFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, YAML.stringify(data, { lineWidth: 120 }));
  renameSync(tmp, file);
}

/** Keys a repository's `.kronos/config.yaml` may override (never secrets, hooks, MCP or safety). */
const PROJECT_SAFE_KEYS = ['model', 'agent', 'toolsets'];

export interface LoadedConfig {
  /** fully merged + env-expanded config used at runtime */
  config: KronosConfig;
  /** merged config before env expansion (what the UI edits) */
  raw: KronosConfig;
  files: { global: string; profile?: string; project?: string; env: string };
}

/**
 * Load configuration: defaults ← ~/.kronos/config.yaml ← profile overlay ← project (safe keys) ← overrides.
 * Secrets live in ~/.kronos/.env (and the profile's .env), referenced as ${VARS}.
 */
export function loadConfig(opts: { home: string; profileRoot: string; cwd?: string; overrides?: unknown }): LoadedConfig {
  const globalFile = join(opts.home, 'config.yaml');
  const envFile = join(opts.home, '.env');
  loadDotenv(join(opts.profileRoot, '.env'));
  loadDotenv(envFile);

  let raw: KronosConfig = defaultConfig();
  raw = deepMerge(raw, readYamlFile(globalFile));
  const files: LoadedConfig['files'] = { global: globalFile, env: envFile };
  if (opts.profileRoot !== opts.home) {
    const pf = join(opts.profileRoot, 'config.yaml');
    files.profile = pf;
    raw = deepMerge(raw, readYamlFile(pf));
  }
  if (opts.cwd) {
    const proj = join(opts.cwd, '.kronos', 'config.yaml');
    if (existsSync(proj)) {
      files.project = proj;
      const data = readYamlFile(proj);
      const safe = Object.fromEntries(Object.entries(data).filter(([k]) => PROJECT_SAFE_KEYS.includes(k)));
      raw = deepMerge(raw, safe);
    }
  }
  if (opts.overrides) raw = deepMerge(raw, opts.overrides);
  normalize(raw);
  return { raw, config: expandEnvDeep(raw), files };
}

function normalize(c: KronosConfig): void {
  // arrays replace rather than merge; guarantee shapes after user edits
  if (!Array.isArray(c.toolsets.enabled)) c.toolsets.enabled = defaultConfig().toolsets.enabled;
  if (!Array.isArray(c.toolsets.disabled)) c.toolsets.disabled = [];
  if (!Array.isArray(c.model.fallbacks)) c.model.fallbacks = [];
  if (!Array.isArray(c.customProviders)) c.customProviders = [];
  c.agent.compaction.threshold = Math.min(0.95, Math.max(0.3, Number(c.agent.compaction.threshold) || 0.8));
  c.agent.compaction.keepRecentTurns = Math.max(0, Math.min(10, Math.round(Number(c.agent.compaction.keepRecentTurns ?? 2))));
  c.agent.compaction.keepToolResults = Math.max(1, Math.round(Number(c.agent.compaction.keepToolResults) || 8));
  c.agent.compaction.clearToolResults = c.agent.compaction.clearToolResults !== false;
  c.agent.maxIterations = Math.max(1, Number(c.agent.maxIterations) || 120);
}

/** Persist a patch into the right config file (profile overlay when not default). */
export function saveConfigPatch(file: string, patch: Record<string, unknown>): void {
  const current = readYamlFile(file);
  writeYamlFile(file, deepMerge(current, patch));
}

export function setConfigValue(file: string, key: string, value: unknown): void {
  const current = readYamlFile(file);
  setPath(current, key, value);
  writeYamlFile(file, current);
}

export function getConfigValue(config: KronosConfig, key: string): unknown {
  return getPath(config, key);
}

/** Mask secrets for display (API responses, `kronos config show`). */
export function maskSecrets<T>(value: T, keyHint = ''): T {
  if (typeof value === 'string') {
    if (/(key|token|secret|password)$/i.test(keyHint) && value && !value.startsWith('${')) {
      return (value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '••••') as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, keyHint)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v, k)])) as T;
  }
  return value;
}
