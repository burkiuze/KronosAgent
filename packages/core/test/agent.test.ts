import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@kronos/core';
import { messageText, toAnthropicMessages, toOpenAIMessages } from '@kronos/core';
import { makeRuntime, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeRuntime();
});
afterEach(async () => {
  await env.cleanup();
});

function collect(events: AgentEvent[]) {
  return (e: AgentEvent) => events.push(e);
}

describe('agent loop (demo model)', () => {
  it('runs a tool round trip and records history, usage and title', async () => {
    writeFileSync(join(env.workspace, 'hello.txt'), 'hi');
    const session = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(session.id);
    const events: AgentEvent[] = [];
    agent.events.on(collect(events));
    const res = await agent.run('list files');
    expect(res.stopReason).toBe('end_turn');
    expect(res.toolCalls).toBe(1);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && call.name).toBe('list_dir');
    const result = events.find((e) => e.type === 'tool_result');
    expect(result && result.type === 'tool_result' && result.content).toContain('hello.txt');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    const roles = env.rt.sessions.messages(session.id).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const stored = env.rt.sessions.get(session.id)!;
    expect(stored.systemPrompt).toContain('You are Kronos');
    expect(stored.toolNames).toContain('read_file');
    expect(stored.usage.outputTokens).toBeGreaterThan(0);
    // auto title is async
    await new Promise((r) => setTimeout(r, 200));
    expect(env.rt.sessions.get(session.id)!.title).not.toBe('New conversation');
  });

  it('writes files with checkpoints and undo restores them', async () => {
    const session = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(session.id);
    await agent.run('create file notes.md');
    const file = join(env.workspace, 'notes.md');
    expect(existsSync(file)).toBe(true);
    expect(env.rt.artifacts.list({ sessionId: session.id }).some((a) => a.location === file)).toBe(true);
    const u = agent.undo();
    expect(u?.restoredFiles).toContain(file);
    expect(existsSync(file)).toBe(false);
    expect(env.rt.sessions.messages(session.id)).toHaveLength(0);
  });

  it('asks for permission in ask mode and respects a denial', async () => {
    const session = env.rt.createSession({ source: 'test', mode: 'ask' });
    const agent = env.rt.agent(session.id, {
      onPermission: async (req) => {
        expect(req.toolName).toBe('write_file');
        return { decision: 'deny', feedback: 'not now' };
      },
    });
    const events: AgentEvent[] = [];
    agent.events.on(collect(events));
    await agent.run('create file blocked.md');
    expect(existsSync(join(env.workspace, 'blocked.md'))).toBe(false);
    const r = events.find((e) => e.type === 'tool_result');
    expect(r && r.type === 'tool_result' && r.content).toMatch(/denied/);
  });

  it('plan mode refuses writes', async () => {
    const session = env.rt.createSession({ source: 'test', mode: 'plan' });
    const agent = env.rt.agent(session.id);
    await agent.run('create file plan.md');
    expect(existsSync(join(env.workspace, 'plan.md'))).toBe(false);
  });

  it('remembers things across sessions via the memory tool', async () => {
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await a.run('remember that I prefer TypeScript over JavaScript');
    expect(env.rt.memory.entries('user').join('\n')).toContain('TypeScript');
    const b = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await b.run('hello');
    expect(env.rt.sessions.get(b.id)!.systemPrompt).toContain('TypeScript');
  });

  it('extracts durable facts automatically when memory.autoExtract is on', async () => {
    env.rt.updateConfig({ memory: { autoExtract: true } });
    try {
      const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
      const events: AgentEvent[] = [];
      a.events.on(collect(events));
      await a.run('Hi! My name is Ada and I use Neovim every day.');
      await env.rt.settle();
      const user = env.rt.memory.entries('user').join('\n');
      expect(user).toContain('Ada');
      expect(user).toContain('Neovim');
      expect(events.some((e) => e.type === 'notice' && e.text.startsWith('Remembered:'))).toBe(true);
    } finally {
      env.rt.updateConfig({ memory: { autoExtract: false } });
    }
  });

  it('codemaster mode injects its workflow once and announces when it turns off', async () => {
    env.rt.updateConfig({ model: { effort: 'codemaster' } });
    try {
      const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
      await a.run('hello');
      await a.run('list files');
      const notes = () => env.rt.sessions.messages(a.id).filter((m) => m.role === 'system' && m.meta?.kind === 'note');
      const on = notes().filter((m) => messageText(m).includes('CODEMASTER MODE'));
      expect(on).toHaveLength(1);
      expect(messageText(on[0]!)).toContain('reviewer subagent');
      env.rt.updateConfig({ model: { effort: 'medium' } });
      await a.run('hello again');
      expect(notes().some((m) => messageText(m).includes('Codemaster mode is now off'))).toBe(true);
    } finally {
      env.rt.updateConfig({ model: { effort: 'medium' } });
    }
  });

  it('delegates to parallel subagents', async () => {
    const session = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(session.id);
    const events: AgentEvent[] = [];
    agent.events.on(collect(events));
    const res = await agent.run('run these in parallel with subagents');
    expect(res.stopReason).toBe('end_turn');
    const subs = events.filter((e) => e.type === 'subagent');
    expect(subs.filter((e) => e.type === 'subagent' && e.status === 'done')).toHaveLength(2);
    const children = env.rt.sessions.list({ includeChildren: true }).filter((s) => s.parentId === session.id);
    expect(children).toHaveLength(2);
  });

  it('can be interrupted and keeps history valid', async () => {
    const session = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(session.id);
    const p = agent.run('hello there, tell me about yourself');
    setTimeout(() => agent.interrupt(), 30);
    const res = await p;
    expect(res.stopReason).toBe('interrupted');
    const res2 = await agent.run('list files');
    expect(res2.stopReason).toBe('end_turn');
  });

  it('compacts long conversations into a summary', async () => {
    const session = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(session.id);
    for (let i = 0; i < 3; i += 1) await agent.run(`list files ${i}`);
    const r = await agent.compact();
    expect(r.after).toBeLessThan(r.before);
    const msgs = env.rt.sessions.messages(session.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.meta?.kind).toBe('summary');
    const next = await agent.run('list files again');
    expect(next.stopReason).toBe('end_turn');
  });

  it('searches past sessions', async () => {
    await env.rt.agent(env.rt.createSession({ source: 'test' }).id).run('remember that the launch codename is ZEPHYR');
    const hits = env.rt.sessions.search('ZEPHYR');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('expands skills, commands and @file mentions', async () => {
    writeFileSync(join(env.workspace, 'spec.md'), '# Spec\nBuild a rocket');
    mkdirSync(join(env.rt.paths.commands), { recursive: true });
    writeFileSync(join(env.rt.paths.commands, 'review.md'), '---\ndescription: review code\n---\nReview $ARGUMENTS carefully');
    const cmd = await env.rt.expandInput('/review src/app.ts');
    expect(cmd.text).toBe('Review src/app.ts carefully');
    const mention = await env.rt.expandInput('summarize @spec.md please', env.workspace);
    expect(mention.files?.[0]?.text).toContain('Build a rocket');
    env.rt.skills.create({ name: 'deploy-app', description: 'Deploy the app', body: 'Step 1: build\nStep 2: ship' });
    const skill = await env.rt.expandInput('/deploy-app to prod');
    expect(skill.text).toContain('Step 2: ship');
    expect(skill.command).toBe('deploy-app');
  });

  it('runs cron jobs headlessly', async () => {
    const job = env.rt.cron.create({ schedule: 'every day at 9am', prompt: 'list files' });
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    const rec = await env.rt.cron.run(job.id);
    expect(rec.status).toBe('ok');
    expect(env.rt.cron.get(job.id)!.runCount).toBe(1);
    expect(readFileSync(join(env.rt.paths.cron, 'runs.jsonl'), 'utf8')).toContain(job.id);
  });
});

describe('provider message conversion', () => {
  const now = Date.now();
  const history = [
    { id: '1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }], createdAt: now },
    {
      id: '2',
      role: 'assistant' as const,
      parts: [
        { type: 'thinking' as const, text: 'think', signature: 'sig', provider: 'anthropic' },
        { type: 'text' as const, text: 'calling' },
        { type: 'tool_call' as const, id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
      createdAt: now,
    },
    { id: '3', role: 'tool' as const, parts: [{ type: 'tool_result' as const, toolCallId: 't1', toolName: 'read_file', content: 'data' }], createdAt: now },
    { id: '4', role: 'system' as const, parts: [{ type: 'text' as const, text: 'note' }], createdAt: now },
  ];
  it('anthropic: replays thinking, groups tool results, places system notes', () => {
    const out = toAnthropicMessages(history, true);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    const assistant = out[1]!.content as { type: string }[];
    expect(assistant[0]!.type).toBe('thinking');
    expect(assistant[2]!.type).toBe('tool_use');
    const legacy = toAnthropicMessages(history, false);
    expect(legacy.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(legacy[2])).toContain('system-reminder');
  });
  it('openai: tool calls and tool messages', () => {
    const out = toOpenAIMessages('sys', history, true);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(out[2]!.tool_calls?.[0]?.function.name).toBe('read_file');
  });
});
