import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import type { Kronos } from '@kronos/core';
import { PROVIDERS, updateDotenv, getPreset } from '@kronos/core';
import { c, logo, sym } from './ui/ansi.js';

/** Interactive first-run wizard: provider + key, default model, safety mode, optional messaging. */
export async function runSetup(rt: Kronos): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = '') => {
    const a = (await rl.question(`${q}${def ? c.gray(` [${def}]`) : ''} `)).trim();
    return a || def;
  };
  const envFile = join(rt.home, '.env');
  console.log(`\n${logo()}\n`);
  console.log(c.bold('Welcome to Kronos Agent setup.\n'));
  console.log('Choose your model provider:');
  const choices = PROVIDERS.filter((p) => p.id !== 'kronos');
  choices.forEach((p, i) => console.log(`  ${c.gold(String(i + 1).padStart(2))}. ${p.label}${p.local ? c.gray(' (local, no key)') : ''}${rt.providers.isConfigured(p.id) && !p.local ? c.green(' ✓ configured') : ''}`));
  const pick = Number(await ask('\nProvider number', '1'));
  const preset = choices[Math.max(0, Math.min(choices.length - 1, pick - 1))] ?? choices[0];
  if (!preset) return;
  if (preset.keyRequired) {
    const envKey = preset.envKeys[0] as string;
    const existing = process.env[envKey];
    console.log(c.gray(`Get a key at ${preset.docsUrl ?? 'your provider dashboard'}`));
    const key = await ask(`${envKey}${existing ? c.gray(' (enter to keep current)') : ''}:`);
    if (key && key !== existing) {
      updateDotenv(envFile, { [envKey]: key });
      console.log(c.green(`${sym.ok} saved to ${envFile}`));
    }
  } else {
    const url = await ask(`${preset.label} URL`, preset.baseUrl);
    rt.updateConfig({ providers: { [preset.id]: { baseUrl: url } } });
  }
  const model = await ask('Default model', `${preset.id}:${getPreset(preset.id)?.defaultModel ?? ''}`);
  console.log('\nPermission mode:');
  console.log(`  ${c.gold('1')}. ask        ${c.gray('— approve file changes and commands (recommended)')}`);
  console.log(`  ${c.gold('2')}. auto-edit  ${c.gray('— file edits auto-approved, commands ask')}`);
  console.log(`  ${c.gold('3')}. yolo       ${c.gray('— everything auto-approved except dangerous commands')}`);
  const mode = (['ask', 'auto-edit', 'yolo'] as const)[Number(await ask('Mode', '1')) - 1] ?? 'ask';
  const name = await ask('Agent name', rt.config.agent.name);
  rt.updateConfig({ model: { default: model }, safety: { mode }, agent: { name } });

  const tg = (await ask('\nConnect Telegram now? (y/N)', 'n')).toLowerCase().startsWith('y');
  if (tg) {
    console.log(c.gray('Create a bot with @BotFather and paste its token.'));
    const token = await ask('TELEGRAM_BOT_TOKEN:');
    const user = await ask('Your Telegram user id (from @userinfobot; blank = pair later):');
    if (token) updateDotenv(envFile, { TELEGRAM_BOT_TOKEN: token });
    rt.updateConfig({ platforms: { telegram: { enabled: true, allowedUsers: user ? [user] : [] } } });
  }
  const search = (await ask('Web search API (tavily/brave/exa/serper, blank = free DuckDuckGo)', '')).toLowerCase();
  const searchEnv: Record<string, string> = { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY', exa: 'EXA_API_KEY', serper: 'SERPER_API_KEY' };
  if (searchEnv[search]) {
    const key = await ask(`${searchEnv[search]}:`);
    if (key) updateDotenv(envFile, { [searchEnv[search] as string]: key });
  }
  rl.close();
  rt.reload();
  const m = rt.providers.resolve();
  console.log(`\n${c.green(sym.ok)} All set. Default model: ${c.bold(m.name)} ${c.gray(`(${m.ref})`)}`);
  console.log(`Run ${c.gold('kronos')} to chat, ${c.gold('kronos web')} for the desktop UI, ${c.gold('kronos gateway')} for messaging.\n`);
}
