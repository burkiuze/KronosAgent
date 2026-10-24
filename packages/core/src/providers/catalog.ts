import type { ModelInfo } from '../types.js';

/**
 * Built-in provider + model catalog. Every OpenAI-compatible endpoint works even if
 * a model is not listed here — the catalog only adds context windows, pricing and
 * capability hints. Users can extend it in config (`customProviders`) and providers
 * expose live model lists via `listModels()`.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  api: 'anthropic' | 'openai' | 'demo';
  baseUrl: string;
  envKeys: string[];
  keyRequired: boolean;
  docsUrl?: string;
  /** model used when the provider is selected without a model */
  defaultModel: string;
  /** cheaper model suited to summaries/titles/subagents */
  smallModel?: string;
  local?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com', envKeys: ['ANTHROPIC_API_KEY'], keyRequired: true, docsUrl: 'https://console.anthropic.com', defaultModel: 'claude-opus-5-5', smallModel: 'claude-haiku-5-5' },
  { id: 'openai', label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', envKeys: ['OPENAI_API_KEY'], keyRequired: true, docsUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-5.5', smallModel: 'gpt-5-mini' },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'], keyRequired: true, docsUrl: 'https://openrouter.ai/keys', defaultModel: 'anthropic/claude-sonnet-5-5' },
  { id: 'gemini', label: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyRequired: true, docsUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-3-pro', smallModel: 'gemini-2.5-flash' },
  { id: 'nous', label: 'Nous Portal', api: 'openai', baseUrl: 'https://inference-api.nousresearch.com/v1', envKeys: ['NOUS_API_KEY'], keyRequired: true, docsUrl: 'https://portal.nousresearch.com', defaultModel: 'Hermes-4-405B' },
  { id: 'nvidia', label: 'NVIDIA NIM', api: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', envKeys: ['NVIDIA_API_KEY'], keyRequired: true, docsUrl: 'https://build.nvidia.com', defaultModel: 'nvidia/nemotron-3-super' },
  { id: 'groq', label: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', envKeys: ['GROQ_API_KEY'], keyRequired: true, docsUrl: 'https://console.groq.com/keys', defaultModel: 'moonshotai/kimi-k2-instruct' },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', envKeys: ['DEEPSEEK_API_KEY'], keyRequired: true, docsUrl: 'https://platform.deepseek.com', defaultModel: 'deepseek-chat' },
  { id: 'mistral', label: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1', envKeys: ['MISTRAL_API_KEY'], keyRequired: true, docsUrl: 'https://console.mistral.ai', defaultModel: 'mistral-large-latest' },
  { id: 'xai', label: 'xAI', api: 'openai', baseUrl: 'https://api.x.ai/v1', envKeys: ['XAI_API_KEY'], keyRequired: true, docsUrl: 'https://console.x.ai', defaultModel: 'grok-4' },
  { id: 'together', label: 'Together AI', api: 'openai', baseUrl: 'https://api.together.xyz/v1', envKeys: ['TOGETHER_API_KEY'], keyRequired: true, defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8' },
  { id: 'fireworks', label: 'Fireworks', api: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', envKeys: ['FIREWORKS_API_KEY'], keyRequired: true, defaultModel: 'accounts/fireworks/models/kimi-k2-instruct' },
  { id: 'cerebras', label: 'Cerebras', api: 'openai', baseUrl: 'https://api.cerebras.ai/v1', envKeys: ['CEREBRAS_API_KEY'], keyRequired: true, defaultModel: 'qwen-3-coder-480b' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', api: 'openai', baseUrl: 'https://api.moonshot.ai/v1', envKeys: ['MOONSHOT_API_KEY'], keyRequired: true, defaultModel: 'kimi-k2-0905-preview' },
  { id: 'zai', label: 'Z.ai (GLM)', api: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', envKeys: ['ZAI_API_KEY'], keyRequired: true, defaultModel: 'glm-4.6' },
  { id: 'ollama', label: 'Ollama (local)', api: 'openai', baseUrl: 'http://127.0.0.1:11434', envKeys: [], keyRequired: false, local: true, defaultModel: 'qwen3-coder:30b' },
  { id: 'lmstudio', label: 'LM Studio (local)', api: 'openai', baseUrl: 'http://127.0.0.1:1234', envKeys: [], keyRequired: false, local: true, defaultModel: 'local-model' },
  { id: 'kronos', label: 'Kronos Demo (offline)', api: 'demo', baseUrl: '', envKeys: [], keyRequired: false, local: true, defaultModel: 'demo' },
];

type M = Omit<ModelInfo, 'ref' | 'provider'>;

const ANTHROPIC: M[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'medium', systemMessages: true, serverFallbacks: true, noSampling: true, description: 'Default. Frontier intelligence for long-horizon agentic work.', tags: ['recommended'] },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', systemMessages: true, serverFallbacks: true, noSampling: true, description: 'Most capable widely released Claude model.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', systemMessages: true, serverFallbacks: true, noSampling: true, description: 'Fast and capable for everyday coding and agents.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'medium', systemMessages: true, noSampling: true, description: 'Fastest and cheapest; great for subagents and summaries.' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', systemMessages: true, serverFallbacks: true, noSampling: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', noSampling: true },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', systemMessages: true, noSampling: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, maxOutput: 128_000, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, vision: true, tools: true, reasoning: 'adaptive', defaultEffort: 'high', noSampling: true },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutput: 64_000, pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, vision: true, tools: true, reasoning: 'budget', noSampling: true },
];

const OPENAI: M[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000, maxOutput: 128_000, vision: true, tools: true, reasoning: 'openai', description: 'OpenAI flagship reasoning model.' },
  { id: 'gpt-5', name: 'GPT-5', contextWindow: 400_000, maxOutput: 128_000, pricing: { input: 1.25, output: 10, cacheRead: 0.125 }, vision: true, tools: true, reasoning: 'openai' },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 400_000, maxOutput: 128_000, pricing: { input: 0.25, output: 2, cacheRead: 0.025 }, vision: true, tools: true, reasoning: 'openai' },
  { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1_047_576, maxOutput: 32_768, pricing: { input: 2, output: 8, cacheRead: 0.5 }, vision: true, tools: true, reasoning: 'none' },
];

const GEMINI: M[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', contextWindow: 1_048_576, maxOutput: 65_536, vision: true, tools: true, reasoning: 'openai' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1_048_576, maxOutput: 65_536, pricing: { input: 1.25, output: 10 }, vision: true, tools: true, reasoning: 'openai' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1_048_576, maxOutput: 65_536, pricing: { input: 0.3, output: 2.5 }, vision: true, tools: true, reasoning: 'openai' },
];

const OTHERS: Record<string, M[]> = {
  openrouter: [
    { id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5 (OpenRouter)', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, tools: true },
    { id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (OpenRouter)', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, tools: true },
    { id: 'openai/gpt-5.5', name: 'GPT-5.5 (OpenRouter)', contextWindow: 400_000, maxOutput: 128_000, vision: true, tools: true },
    { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro (OpenRouter)', contextWindow: 1_048_576, maxOutput: 65_536, vision: true, tools: true },
    { id: 'nousresearch/hermes-4-405b', name: 'Hermes 4 405B (OpenRouter)', contextWindow: 131_072, maxOutput: 32_768, tools: true },
    { id: 'moonshotai/kimi-k2', name: 'Kimi K2 (OpenRouter)', contextWindow: 131_072, maxOutput: 32_768, tools: true },
    { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder (OpenRouter)', contextWindow: 262_144, maxOutput: 65_536, tools: true },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (OpenRouter)', contextWindow: 131_072, maxOutput: 32_768, tools: true },
  ],
  nvidia: [
    { id: 'nvidia/nemotron-3-super', name: 'Nemotron 3 Super', contextWindow: 131_072, maxOutput: 32_768, tools: true, reasoning: 'openai' },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B', contextWindow: 131_072, maxOutput: 32_768, tools: true },
  ],
  nous: [
    { id: 'Hermes-4-405B', name: 'Hermes 4 405B', contextWindow: 131_072, maxOutput: 32_768, tools: true },
    { id: 'Hermes-4-70B', name: 'Hermes 4 70B', contextWindow: 131_072, maxOutput: 32_768, tools: true },
  ],
  groq: [
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 (Groq)', contextWindow: 131_072, maxOutput: 16_384, tools: true },
    { id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b (Groq)', contextWindow: 131_072, maxOutput: 32_768, tools: true, reasoning: 'openai' },
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', contextWindow: 131_072, maxOutput: 32_768, tools: true },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 131_072, maxOutput: 8_192, pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 }, tools: true },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 131_072, maxOutput: 65_536, pricing: { input: 0.55, output: 2.19 }, tools: true, reasoning: 'openai' },
  ],
  mistral: [
    { id: 'mistral-large-latest', name: 'Mistral Large', contextWindow: 131_072, maxOutput: 32_768, tools: true, vision: true },
    { id: 'devstral-medium-latest', name: 'Devstral Medium', contextWindow: 131_072, maxOutput: 32_768, tools: true },
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4', contextWindow: 256_000, maxOutput: 64_000, tools: true, vision: true, reasoning: 'openai' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast', contextWindow: 256_000, maxOutput: 64_000, tools: true },
  ],
  ollama: [
    { id: 'qwen3-coder:30b', name: 'Qwen3 Coder 30B (local)', contextWindow: 65_536, maxOutput: 16_384, tools: true },
    { id: 'gpt-oss:20b', name: 'gpt-oss 20B (local)', contextWindow: 131_072, maxOutput: 16_384, tools: true },
    { id: 'llama3.3', name: 'Llama 3.3 (local)', contextWindow: 131_072, maxOutput: 8_192, tools: true },
  ],
  kronos: [
    { id: 'demo', name: 'Kronos Demo (offline)', contextWindow: 200_000, maxOutput: 8_192, tools: true, vision: true, description: 'Scripted offline model for trying the app without an API key.' },
  ],
};

export function catalogModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  const add = (provider: string, list: M[]) => {
    for (const m of list) out.push({ ...m, provider, ref: `${provider}:${m.id}` });
  };
  add('anthropic', ANTHROPIC);
  add('openai', OPENAI);
  add('gemini', GEMINI);
  for (const [p, list] of Object.entries(OTHERS)) add(p, list);
  return out;
}

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Split "provider:model" (model ids may themselves contain ":" e.g. ollama tags). */
export function parseModelRef(ref: string, knownProviders: string[] = PROVIDERS.map((p) => p.id)): { provider?: string; model: string } {
  const idx = ref.indexOf(':');
  if (idx > 0) {
    const provider = ref.slice(0, idx);
    if (knownProviders.includes(provider)) return { provider, model: ref.slice(idx + 1) };
  }
  return { model: ref };
}

export function guessProviderForModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt)/.test(m)) return 'openai';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('grok')) return 'xai';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (/^(mistral|devstral|codestral|magistral)/.test(m)) return 'mistral';
  if (m.includes('/')) return 'openrouter';
  return undefined;
}

/** Fallback info for models that are not in the catalog. */
export function genericModel(provider: string, id: string): ModelInfo {
  const local = getPreset(provider)?.local;
  return {
    ref: `${provider}:${id}`,
    provider,
    id,
    name: id,
    contextWindow: local ? 32_768 : 128_000,
    maxOutput: local ? 8_192 : 16_384,
    tools: true,
    vision: /vision|vl|4o|gpt-5|gemini|claude|llava|pixtral|grok-4/i.test(id),
    reasoning: /reason|thinking|o\d|gpt-5|r1|qwq|gpt-oss/i.test(id) ? 'openai' : 'none',
  };
}

export function costOf(model: ModelInfo | undefined, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = model?.pricing;
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * (p.cacheRead ?? p.input) +
      usage.cacheWriteTokens * (p.cacheWrite ?? p.input)) /
    1_000_000
  );
}
