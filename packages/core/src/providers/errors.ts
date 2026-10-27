export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class MissingCredentialsError extends ProviderError {
  constructor(provider: string, envKeys: string[]) {
    super(
      `No API key configured for "${provider}". Set ${envKeys.join(' or ') || 'an API key'} (Settings → API Keys, or \`kronos setup\`).`,
      provider,
      401,
      false,
      undefined,
      'missing_credentials',
    );
    this.name = 'MissingCredentialsError';
  }
}

/**
 * No model provider is connected (or the chosen model's provider has no key). Kronos never falls
 * back to the offline demo model on its own; surfaces show a "connect a provider" prompt instead.
 */
export class NotConnectedError extends Error {
  readonly code = 'no_provider';
  constructor(readonly provider?: string) {
    super(
      provider === 'cloud'
        ? 'Kronos Cloud models need a Kronos account with a membership. Sign in and choose a plan (or redeem a promo code) in Settings → Membership, or pick a model from your own provider.'
        : provider
        ? `The ${provider} provider is not connected. Add its API key in Settings → Providers & API keys (or run \`kronos setup\`).`
        : 'No model provider is connected. Connect one in Settings → Providers & API keys (or run `kronos setup`).',
    );
    this.name = 'NotConnectedError';
  }
}

export function isRetryableStatus(status?: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(120_000, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  return undefined;
}
