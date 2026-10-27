// Membership tiers and the hosted models they unlock.
// Daily allowance is in tokens (prompt + completion), reset at 00:00 UTC.
// Pro is the baseline: Max is 2x Pro, Max 5 is 5x Pro.
const PRO_DAILY_TOKENS = 1_000_000;

export const TIERS = {
  lite: { name: "Lite", dailyTokens: PRO_DAILY_TOKENS / 4 },
  pro: { name: "Pro", dailyTokens: PRO_DAILY_TOKENS },
  max: { name: "Max", dailyTokens: PRO_DAILY_TOKENS * 2 },
  max5: { name: "Max 5", dailyTokens: PRO_DAILY_TOKENS * 5 },
};

// id: what the browser sends. slug: the OpenRouter model. provider: the only
// OpenRouter provider the request may be routed to (no fallbacks).
export const MODELS = {
  "glm-5.3-flash": { slug: "z-ai/glm-5.3-flash", provider: "open-inference" },
  "minimax-3.1-flash": { slug: "minimax/minimax-m3.1-flash", provider: "nebius" },
  "nemotron-3.5-super-vl": { slug: "nvidia/nemotron-3.5-super-vl", provider: "crusoe" },
  "deepseek-v4.1-flash": { slug: "deepseek/deepseek-v4.1-flash-1017", provider: "wafer" },
};
