import type { ChatRequest, ChatResponse, ModelInfo, Provider, StreamEvent } from '../types.js';
import type { KronosConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';
import { DemoProvider } from './demo.js';
import { PROVIDERS, catalogModels, genericModel, getPreset, guessProviderForModel, parseModelRef, costOf } from './catalog.js';
import { MissingCredentialsError, ProviderError } from './errors.js';
import { sleep, isAbortError } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('providers');

export interface ProviderStatus {
  id: string;
  label: string;
  api: string;
  configured: boolean;
  local: boolean;
  baseUrl: string;
  envKeys: string[];
  docsUrl?: string;
  custom?: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  /** number of models the provider reported */
  models: number;
  sample: string[];
  latencyMs: number;
  /** false when the provider has no model listing to verify against */
  verified?: boolean;
  error?: string;
}

function describeConnectionError(e: unknown): string {
  const err = e as { status?: number; message?: string; cause?: { code?: string } };
  const status = err.status ?? Number(/\b(40[13]|404|429|5\d\d)\b/.exec(err.message ?? '')?.[1] ?? NaN);
  if (status === 401 || status === 403) return 'The API key was rejected (unauthorized). Check that it is correct and active.';
  if (status === 404) return 'The endpoint was not found — check the base URL.';
  if (status === 429) return 'Rate limited or out of credits on this account.';
  if (status >= 500) return `The provider returned a server error (${status}). Try again shortly.`;
  const code = err.cause?.code ?? '';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(`${code} ${err.message ?? ''}`)) return 'Could not reach the provider — is the URL right and the server running?';
  return (err.message ?? String(e)).slice(0, 300);
}

/** Auto-selection order when model.default is "auto". */
const AUTO_ORDER = ['anthropic', 'openai', 'openrouter', 'gemini', 'nous', 'nvidia', 'xai', 'deepseek', 'mistral', 'groq', 'moonshot', 'zai', 'together', 'fireworks', 'cerebras'];

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  private liveModels = new Map<string, ModelInfo[]>();

  constructor(private config: KronosConfig) {}

  updateConfig(config: KronosConfig): void {
    this.config = config;
    this.cache.clear();
  }

  private keyFor(id: string): string | undefined {
    const cfg = this.config.providers[id];
    if (cfg?.apiKey) return cfg.apiKey;
    const custom = this.config.customProviders.find((c) => c.id === id);
    if (custom?.apiKey) return custom.apiKey;
    for (const k of getPreset(id)?.envKeys ?? []) if (process.env[k]) return process.env[k];
    return undefined;
  }

  isConfigured(id: string): boolean {
    if (id === 'kronos') return true;
    const preset = getPreset(id);
    const custom = this.config.customProviders.find((c) => c.id === id);
    if (custom) return Boolean(custom.baseUrl);
    if (!preset) return false;
    if (this.config.providers[id]?.enabled === false) return false;
    if (!preset.keyRequired) return true;
    if (id === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) return true;
    return Boolean(this.keyFor(id));
  }

  statuses(): ProviderStatus[] {
    const list: ProviderStatus[] = PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      api: p.api,
      configured: this.isConfigured(p.id),
      local: Boolean(p.local),
      baseUrl: this.config.providers[p.id]?.baseUrl || p.baseUrl,
      envKeys: p.envKeys,
      docsUrl: p.docsUrl,
    }));
    for (const c of this.config.customProviders) {
      list.push({ id: c.id, label: c.label ?? c.id, api: c.api ?? 'openai', configured: Boolean(c.baseUrl), local: /localhost|127\.0\.0\.1/.test(c.baseUrl), baseUrl: c.baseUrl, envKeys: [], custom: true });
    }
    return list;
  }

  knownProviderIds(): string[] {
    return [...PROVIDERS.map((p) => p.id), ...this.config.customProviders.map((c) => c.id)];
  }

  get(id: string): Provider {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const provider = this.build(id);
    this.cache.set(id, provider);
    return provider;
  }

  /** Construct a provider client; `apiKey` overrides the configured key (used to test a key before saving it). */
  private build(id: string, apiKey?: string): Provider {
    let provider: Provider;
    const custom = this.config.customProviders.find((c) => c.id === id);
    const preset = getPreset(id);
    const cfg = this.config.providers[id] ?? {};
    if (custom) {
      provider =
        custom.api === 'anthropic'
          ? new AnthropicProvider({ id, apiKey: apiKey ?? custom.apiKey, baseUrl: custom.baseUrl, headers: custom.headers, serverFallbacks: false })
          : new OpenAICompatProvider({ id, label: custom.label, baseUrl: custom.baseUrl, apiKey: apiKey ?? custom.apiKey, headers: custom.headers, flavor: 'generic' });
    } else if (!preset) {
      throw new ProviderError(`Unknown provider "${id}". Known: ${this.knownProviderIds().join(', ')}`, id);
    } else if (preset.api === 'demo') {
      provider = new DemoProvider();
    } else if (preset.api === 'anthropic') {
      provider = new AnthropicProvider({
        id,
        apiKey: apiKey ?? this.keyFor(id),
        baseUrl: cfg.baseUrl || undefined,
        headers: cfg.headers,
        serverFallbacks: cfg.serverFallbacks,
        dropMismatchedThinking: cfg.dropMismatchedThinking,
        promptCaching: cfg.promptCaching,
      });
    } else {
      provider = new OpenAICompatProvider({
        id,
        label: preset.label,
        baseUrl: cfg.baseUrl || preset.baseUrl,
        apiKey: apiKey ?? this.keyFor(id),
        keyRequired: preset.keyRequired,
        envKeys: preset.envKeys,
        headers: cfg.headers,
        flavor: id === 'openai' ? 'openai' : id === 'openrouter' ? 'openrouter' : preset.local ? 'ollama' : 'generic',
      });
    }
    return provider;
  }

  /** Pick the default model when the config says "auto". */
  autoModelRef(): string {
    for (const id of AUTO_ORDER) {
      if (this.isConfigured(id)) {
        const preset = getPreset(id);
        if (preset) return `${id}:${preset.defaultModel}`;
      }
    }
    for (const c of this.config.customProviders) if (c.baseUrl && c.models?.[0]) return `${c.id}:${c.models[0]}`;
    return 'kronos:demo';
  }

  smallModelRef(forRef: string): string {
    const { provider } = parseModelRef(forRef, this.knownProviderIds());
    const preset = provider ? getPreset(provider) : undefined;
    if (preset?.smallModel && this.isConfigured(preset.id)) return `${preset.id}:${preset.smallModel}`;
    return forRef;
  }

  /** Resolve "auto", "provider:model", bare model ids and aliases into catalog info. */
  resolve(ref?: string | null): ModelInfo {
    let r = (ref ?? '').trim();
    if (!r || r === 'auto' || r === 'default') {
      const def = this.config.model.default;
      r = !def || def === 'auto' ? this.autoModelRef() : def;
      if (r === 'auto') r = this.autoModelRef();
    }
    r = aliasFor(r) ?? r;
    let { provider, model } = parseModelRef(r, this.knownProviderIds());
    if (!provider) provider = guessProviderForModel(model) ?? parseModelRef(this.autoModelRef()).provider ?? 'kronos';
    if (!model) model = getPreset(provider)?.defaultModel ?? model;
    const all = [...catalogModels(), ...(this.liveModels.get(provider) ?? [])];
    const found = all.find((m) => m.provider === provider && m.id === model);
    if (found) return found;
    // OpenRouter ids embed a vendor model we may know about
    const base = all.find((m) => m.id === model.split('/').pop());
    const info = genericModel(provider, model);
    if (base) {
      info.contextWindow = base.contextWindow;
      info.maxOutput = base.maxOutput;
      info.vision = base.vision;
    }
    return info;
  }

  async listModels(providerId?: string): Promise<ModelInfo[]> {
    const catalog = catalogModels();
    const ids = providerId ? [providerId] : this.statuses().filter((s) => s.configured).map((s) => s.id);
    const out: ModelInfo[] = [];
    for (const id of ids) {
      const known = catalog.filter((m) => m.provider === id);
      out.push(...known);
      const custom = this.config.customProviders.find((c) => c.id === id);
      for (const m of custom?.models ?? []) if (!out.some((x) => x.ref === `${id}:${m}`)) out.push(genericModel(id, m));
      if (providerId && this.isConfigured(id)) {
        try {
          const p = this.get(id);
          const live = (await p.listModels?.()) ?? [];
          this.liveModels.set(id, live);
          for (const m of live) if (!out.some((x) => x.ref === m.ref)) out.push(m);
        } catch (e) {
          log.debug(`listModels(${id}) failed`, e);
        }
      }
    }
    return out;
  }

  /**
   * Check that a provider is reachable and its credentials work by listing its models —
   * no tokens are spent. Used by the "Connect a provider" flow in the apps.
   */
  async testConnection(id: string, opts: { apiKey?: string; timeoutMs?: number } = {}): Promise<ConnectionTest> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const done = (r: Omit<ConnectionTest, 'latencyMs'>): ConnectionTest => ({ ...r, latencyMs: Date.now() - started });
    if (!this.knownProviderIds().includes(id)) return done({ ok: false, models: 0, sample: [], error: `Unknown provider "${id}"` });
    if (!opts.apiKey && !this.isConfigured(id)) return done({ ok: false, models: 0, sample: [], error: 'No API key saved for this provider yet.' });
    let provider: Provider;
    try {
      provider = opts.apiKey ? this.build(id, opts.apiKey) : this.get(id);
    } catch (e) {
      return done({ ok: false, models: 0, sample: [], error: (e as Error).message });
    }
    if (!provider.listModels) {
      const known = catalogModels().filter((m) => m.provider === id);
      return done({ ok: true, models: known.length, sample: known.slice(0, 6).map((m) => m.id), verified: false });
    }
    try {
      const live = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new ProviderError(`no answer within ${Math.round(timeoutMs / 1000)}s`, id)), timeoutMs)),
      ]);
      if (!opts.apiKey) this.liveModels.set(id, live);
      return done({ ok: true, models: live.length, sample: live.slice(0, 6).map((m) => m.id), verified: true });
    } catch (e) {
      return done({ ok: false, models: 0, sample: [], error: describeConnectionError(e) });
    }
  }

  costOf(model: ModelInfo, usage: Parameters<typeof costOf>[1]): number {
    return costOf(model, usage);
  }

  /**
   * Run a chat request with retries (backoff + retry-after) and the configured
   * fallback chain. Emits notices so every UI can show what happened.
   */
  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void, fallbacks: string[] = this.config.model.fallbacks): Promise<ChatResponse & { modelInfo: ModelInfo }> {
    const chain: ModelInfo[] = [req.model, ...fallbacks.map((f) => this.resolve(f)).filter((m) => m.ref !== req.model.ref)];
    let lastErr: unknown;
    for (const [i, model] of chain.entries()) {
      if (i > 0) onEvent({ type: 'notice', level: 'warn', text: `Falling back to ${model.name} (${model.ref}).` });
      const provider = this.get(model.provider);
      // the Anthropic SDK retries internally; add a light outer retry for every provider
      const maxAttempts = provider instanceof AnthropicProvider ? 2 : 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await provider.chat({ ...req, model }, onEvent);
          return { ...res, modelInfo: model };
        } catch (e) {
          lastErr = e;
          if (isAbortError(e) || req.signal?.aborted) throw e;
          if (e instanceof MissingCredentialsError) break;
          const retryable = e instanceof ProviderError ? e.retryable : true;
          if (!retryable || attempt === maxAttempts) break;
          const wait = (e instanceof ProviderError && e.retryAfterMs) || Math.min(30_000, 1000 * 2 ** (attempt - 1) + Math.random() * 400);
          onEvent({ type: 'notice', level: 'warn', text: `${model.name}: ${(e as Error).message.slice(0, 160)} — retrying in ${Math.round(wait / 1000)}s` });
          await sleep(wait, req.signal);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

const ALIASES: Record<string, string> = {
  opus: 'anthropic:claude-opus-5-5',
  sonnet: 'anthropic:claude-sonnet-5-5',
  haiku: 'anthropic:claude-haiku-5-5',
  fable: 'anthropic:claude-fable-5-1',
  claude: 'anthropic:claude-opus-5-5',
  gpt: 'openai:gpt-5.5',
  gemini: 'gemini:gemini-3-pro',
  hermes: 'nous:Hermes-4-405B',
  nemotron: 'nvidia:nvidia/nemotron-3-super',
  grok: 'xai:grok-4',
  deepseek: 'deepseek:deepseek-chat',
  kimi: 'groq:moonshotai/kimi-k2-instruct',
  demo: 'kronos:demo',
  local: 'ollama:qwen3-coder:30b',
};

export function aliasFor(ref: string): string | undefined {
  return ALIASES[ref.toLowerCase()];
}

export function modelAliases(): Record<string, string> {
  return { ...ALIASES };
}
