import { useSyncExternalStore } from 'react';
import { baseUrl, get, post } from './api';
import { toast } from './store';

/** The Kronos account (heynavio.com) as the gateway reports it. */

export interface UsageWindow {
  spentMicro: number;
  limitMicro: number;
  percent: number;
  resetsAt: string | null;
}

export interface AccountStatus {
  signedIn: boolean;
  skipped: boolean;
  onboarded: boolean;
  account: {
    email: string | null;
    plan: { id: string; name: string } | null;
    planExpiresAt: string | null;
    usage: { fiveHour: UsageWindow; week: UsageWindow };
  } | null;
  models: { id: string; name: string; provider: string; contextWindow: number; vision: boolean; description?: string }[];
  plans: { id: string; name: string; multiplier: number; description: string }[];
  cloudUrl: string;
  checkedAt: number | null;
  error?: string;
}

interface State {
  status: AccountStatus | null;
  /** a browser sign-in is under way */
  waiting: boolean;
  /** the sign-in page, offered as a link in case the browser blocked the new tab */
  signInUrl?: string;
}

let state: State = { status: null, waiting: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

export function useAccount(): State {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

export async function loadAccount(refresh = false): Promise<AccountStatus | null> {
  try {
    const s = refresh ? await post<AccountStatus>('/api/account/refresh') : await get<AccountStatus>('/api/account');
    set({ status: s });
    return s;
  } catch {
    return state.status;
  }
}

let poll: ReturnType<typeof setInterval> | undefined;

/** Opens heynavio.com in the browser and waits for Kronos to be connected. */
export async function startSignIn(mode: 'sign-in' | 'sign-up' = 'sign-in'): Promise<void> {
  const origin = baseUrl || window.location.origin;
  const { url } = await post<{ url: string }>('/api/account/login', { origin, mode });
  // the desktop app hands this to the system browser; a blocked tab still has the link on screen
  window.open(url, '_blank');
  set({ waiting: true, signInUrl: url });
  clearInterval(poll);
  const started = Date.now();
  poll = setInterval(async () => {
    const s = await loadAccount();
    if (s?.signedIn) {
      clearInterval(poll);
      set({ waiting: false });
      toast(s.account?.email ? `Signed in as ${s.account.email}` : 'Signed in', 'ok');
      void loadAccount(true);
    } else if (Date.now() - started > 15 * 60_000) {
      clearInterval(poll);
      set({ waiting: false });
    }
  }, 2000);
}

export function cancelSignIn(): void {
  clearInterval(poll);
  set({ waiting: false });
}

export async function skipAccount(): Promise<void> {
  set({ status: await post<AccountStatus>('/api/account/skip') });
}

export async function signOut(): Promise<void> {
  set({ status: await post<AccountStatus>('/api/account/logout') });
  toast('Signed out of Kronos', 'info');
}

export async function redeemCode(code: string): Promise<AccountStatus> {
  const s = await post<AccountStatus>('/api/account/redeem', { code });
  set({ status: s });
  return s;
}

export function fmtReset(iso: string | null): string {
  if (!iso) return 'Starts with your next request';
  return `Resets ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
