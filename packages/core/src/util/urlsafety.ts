import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * URL safety for the agent's web tools (after Hermes' url_safety / browser_url_policy): cloud
 * instance-metadata endpoints are refused always — a prompt-injected "fetch
 * http://169.254.169.254/…" would hand over the machine's cloud credentials — and so is every
 * link-local address, also when a hostname resolves to one or a redirect points there. Local
 * development servers (localhost, LAN) stay reachable.
 */

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.internal', 'instance-data', 'instance-data.ec2.internal']);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '169.254.169.123', '100.100.100.200', 'fd00:ec2::254', '::ffff:169.254.169.254']);

function linkLocal(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) return v.startsWith('169.254.');
  return v.startsWith('fe80') || v === 'fd00:ec2::254';
}

/** Why the agent may not fetch `url`, or undefined. */
export async function urlBlocked(url: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `only http and https URLs can be fetched (got ${u.protocol})`;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(host) || METADATA_IPS.has(host) || (isIP(host) && linkLocal(host))) return `${host} is a cloud metadata / link-local address; it is never fetched`;
  if (!isIP(host)) {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (addrs.some((a) => METADATA_IPS.has(a.address) || linkLocal(a.address))) return `${host} resolves to a cloud metadata / link-local address; it is never fetched`;
  }
  return undefined;
}

/** fetch() that checks the URL and every redirect hop. */
export async function safeFetch(url: string, init: RequestInit & { maxRedirects?: number } = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= (init.maxRedirects ?? 8); hop++) {
    const why = await urlBlocked(current);
    if (why) throw new Error(`Blocked: ${why}`);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location') as string, current).href;
      // a redirect turns POST into GET (except 307/308), as browsers do
      if (res.status !== 307 && res.status !== 308) init = { ...init, method: 'GET', body: undefined };
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}
