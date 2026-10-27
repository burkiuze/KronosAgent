import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kronos, type KronosOptions } from '@kronos/core';

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'KRONOS_CLOUD_TOKEN'];

export interface TestEnv {
  home: string;
  workspace: string;
  rt: Kronos;
  cleanup(): Promise<void>;
}

/** Isolated Kronos runtime on a temp home + workspace, using the offline demo model. */
export async function makeRuntime(overrides: KronosOptions['overrides'] = {}): Promise<TestEnv> {
  for (const k of KEYS) delete process.env[k];
  const home = mkdtempSync(join(tmpdir(), 'kronos-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'kronos-ws-'));
  const rt = await Kronos.create({
    home,
    profile: 'default',
    cwd: workspace,
    connectMcp: false,
    logLevel: 'silent',
    overrides: {
      model: { default: 'kronos:demo' },
      safety: { mode: 'yolo' },
      skills: { claudeCompat: false },
      ...overrides,
    } as KronosOptions['overrides'],
  });
  return {
    home,
    workspace,
    rt,
    async cleanup() {
      await rt.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
