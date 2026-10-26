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

/** consecutive failed requests (after retries) before a provider is skipped for a while */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  private liveModels = new Map<string, ModelInfo[]>();
  /**
   * Circuit breaker per provider: after repeated failures a provider is skipped for a cooldown
   * when the fallback chain has an alternative, instead of every request waiting through the
   * same retries and backoff again.
   */
  private health = new Map<string, { failures: number; openUntil: number }>();

  /** Providers currently being skipped, with seconds left. */
  breakerStatus(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, h] of this.health) if (h.openUntil > now) out[id] = Math.ceil((h.openUntil - now) / 1000);
    return out;
  }

  constructor(private config: KronosConfig) {}

  updateConfig(config: KronosConfig): void {
    this.config = config;
    this.cache.clear();
  }

  /** The configured key text: one key, or several separated by commas/newlines (a key pool). */
  private rawKeyFor(id: string): string | undefined {
    const cfg = this.config.providers[id];
    if (cfg?.apiKey) return cfg.apiKey;
    const custom = this.config.customProviders.find((c) => c.id === id);
    if (custom?.apiKey) return custom.apiKey;
    for (const k of getPreset(id)?.envKeys ?? []) if (process.env[k]) return process.env[k];
    return undefined;
  }

  /** Every key of a provider (after Hermes' credential pool: rotate on rate limits and rejections). */
  keysFor(id: string): string[] {
    return [...new Set((this.rawKeyFor(id) ?? '').split(/[\s,]+/).filter(Boolean))];
  }

  private keyIndex = new Map<string, number>();
  private keyCooldown = new Map<string, number>();

  private keyFor(id: string): string | undefined {
    const keys = this.keysFor(id);
    if (keys.length <= 1) return keys[0] ?? this.rawKeyFor(id);
    const start = this.keyIndex.get(id) ?? 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(start + i) % keys.length] as string;
      if ((this.keyCooldown.get(k) ?? 0) <= Date.now()) return k;
    }
    return keys[start % keys.length];
  }

  /**
   * After a rate limit, exhausted quota or a rejected key, move to the provider's next key that is not
   * cooling down. Returns its position (1-based) and the pool size, or undefined when there is none.
   */
  rotateKey(id: string, err: ProviderError): { index: number; of: number; reason: string } | undefined {
    const keys = this.keysFor(id);
    if (keys.length < 2) return undefined;
    const current = this.keyFor(id) as string;
    const reason = err.status === 429 ? 'rate limited' : err.status === 402 || /quota|credit|billing/i.test(err.message) ? 'out of quota' : 'rejected';
    const coolMs = err.status === 429 ? Math.max(err.retryAfterMs ?? 0, 60_000) : 6 * 3600_000;
    this.keyCooldown.set(current, Date.now() + coolMs);
    const at = keys.indexOf(current);
    for (let i = 1; i < keys.length; i++) {
      const j = (at + i) % keys.length;
      if ((this.keyCooldown.get(keys[j] as string) ?? 0) <= Date.now()) {
        this.keyIndex.set(id, j);
        this.cache.delete(id);
        return { index: j + 1, of: keys.length, reason };
      }
    }
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
          ? new AnthropicProvider({ id, apiKey: apiKey ?? this.keyFor(id), baseUrl: custom.baseUrl, headers: custom.headers, serverFallbacks: false })
          : new OpenAICompatProvider({ id, label: custom.label, baseUrl: custom.baseUrl, apiKey: apiKey ?? this.keyFor(id), headers: custom.headers, flavor: 'generic' });
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

  /** The offline demo model runs only when it was chosen on purpose (config default or an explicit ref). */
  demoAllowed(ref?: string | null): boolean {
    const named = (r?: string | null) => Boolean(r && /^(kronos:|demo$)/i.test(r.trim()));
    return named(ref) || named(this.config.model.default);
  }

  /**
   * Whether a model can be used right now: some provider must be connected (the demo model is
   * never an automatic fallback), and the chosen model's provider must have its key.
   */
  readiness(ref?: string | null): { ok: true } | { ok: false; reason: 'no_provider' | 'missing_key'; provider?: string } {
    const model = this.resolve(ref);
    if (model.provider === 'kronos') return this.demoAllowed(ref) ? { ok: true } : { ok: false, reason: 'no_provider' };
    if (!this.isConfigured(model.provider)) return { ok: false, reason: 'missing_key', provider: model.provider };
    return { ok: true };
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
    const all: ModelInfo[] = [req.model, ...fallbacks.map((f) => this.resolve(f)).filter((m) => m.ref !== req.model.ref)];
    const now = Date.now();
    const healthy = all.filter((m) => (this.health.get(m.provider)?.openUntil ?? 0) <= now);
    // with everything tripped, still try the chain rather than fail without a request
    const chain = healthy.length ? healthy : all;
    for (const m of all) if (!chain.includes(m)) onEvent({ type: 'notice', level: 'warn', text: `Skipping ${m.name}: ${m.provider} failed repeatedly; retrying it in ${this.breakerStatus()[m.provider] ?? 0}s.` });
    let lastErr: unknown;
    let streamed = false;
    const track = (e: StreamEvent) => {
      if (e.type !== 'notice') streamed = true;
      onEvent(e);
    };
    // anything an earlier attempt streamed is discarded before the next one starts
    const restart = () => {
      if (streamed) onEvent({ type: 'restart' });
      streamed = false;
    };
    for (const [i, model] of chain.entries()) {
      if (i > 0) {
        restart();
        onEvent({ type: 'notice', level: 'warn', text: `Falling back to ${model.name} (${model.ref}).` });
      }
      const provider = this.get(model.provider);
      // the Anthropic SDK retries internally; add a light outer retry for every provider
      const maxAttempts = provider instanceof AnthropicProvider ? 2 : 4;
      let failed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          if (attempt > 1) restart();
          const res = await this.get(model.provider).chat({ ...req, model }, track);
          this.health.delete(model.provider);
          return { ...res, modelInfo: model };
        } catch (e) {
          lastErr = e;
          if (isAbortError(e) || req.signal?.aborted) throw e;
          if (e instanceof MissingCredentialsError) break;
          // a pool of keys: switch to the next one right away instead of waiting or falling back
          if (e instanceof ProviderError && (e.status === 429 || e.status === 401 || e.status === 403 || e.status === 402)) {
            const next = this.rotateKey(model.provider, e);
            if (next) {
              onEvent({ type: 'notice', level: 'warn', text: `${model.provider}: key ${next.reason} — switched to key ${next.index} of ${next.of}.` });
              attempt -= 1;
              continue;
            }
          }
          const retryable = e instanceof ProviderError ? e.retryable : true;
          if (!retryable || attempt === maxAttempts) {
            failed = retryable;
            break;
          }
          const wait = (e instanceof ProviderError && e.retryAfterMs) || Math.min(30_000, 1000 * 2 ** (attempt - 1) + Math.random() * 400);
          onEvent({ type: 'notice', level: 'warn', text: `${model.name}: ${(e as Error).message.slice(0, 160)} — retrying in ${Math.round(wait / 1000)}s` });
          await sleep(wait, req.signal);
        }
      }
      if (failed) {
        // only outages trip the breaker; a rejected request (bad input, auth) says nothing about the provider's health
        const h = this.health.get(model.provider) ?? { failures: 0, openUntil: 0 };
        h.failures += 1;
        if (h.failures >= BREAKER_THRESHOLD) h.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        this.health.set(model.provider, h);
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
