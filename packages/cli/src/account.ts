import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccountStatus, Kronos } from '@kronos/core';
import { c, sym } from './ui/ansi.js';

export const ACCOUNT_HELP = `${c.bold('kronos account')} — your Kronos account and Kronos Cloud membership

  kronos login [--sign-up]     sign in (or create an account) in the browser
  kronos logout                sign this computer out
  kronos account               plan, usage and Kronos Cloud models
  kronos redeem <code>         redeem a promo code`;

function pct(p: number): string {
  const n = Math.round(p / 5);
  return `${'█'.repeat(n)}${c.gray('░'.repeat(20 - n))} ${p}%`;
}

export function printAccount(s: AccountStatus): void {
  if (!s.signedIn) {
    console.log(`  ${c.gray('○')} Not signed in ${c.gray('— kronos login (Kronos works without an account using your own API keys)')}`);
    return;
  }
  const a = s.account;
  console.log(`  ${c.green('●')} ${a?.email ?? 'Signed in'}`);
  if (a?.plan) {
    console.log(`  ${c.bold(a.plan.name)}${a.planExpiresAt ? c.gray(` · until ${new Date(a.planExpiresAt).toLocaleDateString()}`) : ''}`);
    console.log(`  5-hour  ${pct(a.usage.fiveHour.percent)}${a.usage.fiveHour.resetsAt ? c.gray(` · resets ${new Date(a.usage.fiveHour.resetsAt).toLocaleString()}`) : ''}`);
    console.log(`  week    ${pct(a.usage.week.percent)}${a.usage.week.resetsAt ? c.gray(` · resets ${new Date(a.usage.week.resetsAt).toLocaleString()}`) : ''}`);
  } else {
    console.log(`  ${c.yellow('No membership')} ${c.gray(`— Kronos Cloud models need Lite, Pro, Max or Max 5. Plans: ${s.cloudUrl}/kronosagent#plans · promo code: kronos redeem <code>`)}`);
  }
  console.log(c.gray(`\n  Kronos Cloud models${a?.plan ? '' : ' (locked)'}: ${s.models.map((m) => `cloud:${m.id}`).join(', ')}`));
}

/** Browser sign-in with a one-off listener on 127.0.0.1 for the callback. */
export async function cmdLogin(rt: Kronos, opts: { signUp?: boolean; openBrowser: (url: string) => void }): Promise<void> {
  const result = await new Promise<AccountStatus>((resolveLogin, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const finish = (ok: boolean, text: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;background:#0b0b0d;color:#ececf1;display:grid;place-items:center;min-height:100vh"><p>${text}</p>`);
        server.close();
        clearTimeout(timer);
      };
      if (url.searchParams.get('error')) {
        finish(false, 'Sign-in cancelled. You can close this tab.');
        reject(new Error('sign-in was cancelled'));
        return;
      }
      rt.account
        .completeLogin(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '')
        .then((s) => {
          finish(true, 'Kronos is connected. You can close this tab and go back to the terminal.');
          resolveLogin(s);
        })
        .catch((e: Error) => {
          finish(false, `Sign-in did not finish: ${e.message.replace(/[<>&]/g, '')}`);
          reject(e);
        });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('no answer from the browser within 10 minutes — run kronos login again'));
    }, 10 * 60_000);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const { url } = rt.account.startLogin(`http://127.0.0.1:${port}/callback`, { mode: opts.signUp ? 'sign-up' : 'sign-in' });
      console.log(`\n  ${opts.signUp ? 'Create your account' : 'Sign in'} in the browser:\n  ${c.cyan(url)}\n`);
      opts.openBrowser(url);
      console.log(c.gray('  Waiting for the browser… (Ctrl+C to cancel)'));
    });
  });
  console.log(`${c.green(sym.ok)} Signed in\n`);
  printAccount(result);
}

export async function cmdAccount(rt: Kronos, pos: string[]): Promise<void> {
  if (pos[0] === 'help') return void console.log(ACCOUNT_HELP);
  const s = await rt.account.refresh();
  if (s.error) console.log(c.yellow(`${sym.warn} ${s.error}`));
  printAccount(s);
}

export async function cmdRedeem(rt: Kronos, code: string | undefined): Promise<void> {
  if (!code) throw new Error('usage: kronos redeem <code>');
  const s = await rt.account.redeem(code);
  console.log(`${c.green(sym.ok)} Code redeemed\n`);
  printAccount(s);
}

export async function cmdLogout(rt: Kronos): Promise<void> {
  await rt.account.logout();
  console.log(`${c.green(sym.ok)} Signed out of Kronos`);
}
