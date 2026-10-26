import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  dedupeFindings,
  findSnippet,
  findingsFromText,
  formatSarif,
  githubReview,
  groupFiles,
  locateFinding,
  parseUnifiedDiff,
  selectFiles,
  checklistsFor,
  loadProjectRules,
  rulesFor,
  type ChatRequest,
  type ChatResponse,
  type Finding,
  type Provider,
  type ToolCallPart,
} from '@kronos/core';
import { makeRuntime, type TestEnv } from './helpers.js';

const DIFF = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,5 +1,7 @@
 export function average(xs: number[]): number {
-  if (xs.length === 0) return 0;
-  return xs.reduce((a, b) => a + b, 0) / xs.length;
+  let sum = 0;
+  for (let i = 0; i <= xs.length; i++) sum += xs[i];
+  return sum / xs.length;
 }
+
+export const half = (x: number) => x / 2;
diff --git a/README.md b/docs/README.md
similarity index 90%
rename from README.md
rename to docs/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/docs/README.md
@@ -1,2 +1,2 @@
-# Old
+# New
 text
diff --git a/package-lock.json b/package-lock.json
index 5555555..6666666 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"a":1}
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..8888888
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+--- not a header
+export const x = 1;
`;

describe('unified diff parsing', () => {
  const files = parseUnifiedDiff(DIFF);

  it('reads paths, status, line numbers and binary files', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/math.ts', 'modified'],
      ['docs/README.md', 'renamed'],
      ['package-lock.json', 'modified'],
      ['logo.png', 'added'],
      ['src/new.ts', 'added'],
    ]);
    const math = files[0]!;
    expect(math.additions).toBe(5);
    expect(math.deletions).toBe(2);
    const added = math.hunks[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.newNo);
    expect(added).toEqual([2, 3, 4, 6, 7]);
    expect(files[1]!.oldPath).toBe('README.md');
    expect(files[3]!.binary).toBe(true);
    // a "--- " line inside a hunk is content, not a new file
    expect(files[4]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['--- not a header', 'export const x = 1;']);
  });

  it('sets aside lock, binary and secret files, and groups tests with their code', () => {
    const { selected, skipped } = selectFiles(files);
    expect(selected.map((f) => f.path)).toEqual(['src/math.ts', 'docs/README.md', 'src/new.ts']);
    expect(skipped).toEqual([
      { path: 'package-lock.json', reason: 'lock file' },
      { path: 'logo.png', reason: 'binary file' },
    ]);
    const extra = parseUnifiedDiff(
      ['src/math.test.ts', 'src/z.ts', 'lib/a.ts', '.env'].map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join(''),
    );
    expect(selectFiles(extra).skipped).toEqual([{ path: '.env', reason: 'may contain secrets' }]);
    const groups = groupFiles([...selected, ...selectFiles(extra).selected], { maxFiles: 2 });
    const withTest = groups.find((g) => g.files.some((f) => f.path === 'src/math.ts'))!;
    expect(withTest.files.map((f) => f.path)).toEqual(['src/math.ts', 'src/math.test.ts']);
    expect(groups.flatMap((g) => g.files).length).toBe(6);
    expect(groups.every((g) => g.files.length <= 2)).toBe(true);
  });
});

describe('placing findings', () => {
  const files = parseUnifiedDiff(DIFF);
  const views = new Map(files.map((f) => [f.path, { diff: f, lines: f.path === 'src/math.ts' ? ['export function average(xs: number[]): number {', '  let sum = 0;', '  for (let i = 0; i <= xs.length; i++) sum += xs[i];', '  return sum / xs.length;', '}', '', 'export const half = (x: number) => x / 2;'] : undefined }]));
  const base: Finding = { id: '', path: 'src/math.ts', startLine: 40, endLine: 40, title: 'Off by one', body: 'Reads past the end.', severity: 'high', category: 'bug', confidence: 0.9, group: 1, located: 'line', inDiff: false };

  it('trusts the quoted code over drifting line numbers', () => {
    const f = locateFinding({ ...base, existingCode: '    for (let i = 0; i <= xs.length; i++) sum += xs[i];' }, views)!;
    expect([f.startLine, f.endLine, f.located, f.inDiff]).toEqual([3, 3, 'quote', true]);
  });

  it('moves a finding to the one changed file that has the quote, and resolves partial paths', () => {
    const f = locateFinding({ ...base, path: 'src/new.ts', existingCode: 'export const half = (x: number) => x / 2;' }, views)!;
    expect([f.path, f.startLine, f.located]).toEqual(['src/math.ts', 7, 'moved']);
    expect(locateFinding({ ...base, path: 'math.ts', startLine: 4, endLine: 4 }, views)?.path).toBe('src/math.ts');
    expect(locateFinding({ ...base, path: 'src/unrelated.ts' }, views)).toBeUndefined();
  });

  it('finds snippets ignoring indentation and partial first/last lines', () => {
    const lines = ['a()', '  if (x) {', '    y();', '  }'];
    expect(findSnippet(lines, 'if (x) {\n y();')).toEqual([{ start: 2, end: 3 }]);
    expect(findSnippet(lines, 'nope')).toEqual([]);
  });

  it('merges duplicates, keeping the most severe', () => {
    const a = { ...base, startLine: 3, endLine: 3, title: 'Loop reads past the end of xs', severity: 'medium' as const };
    const b = { ...base, startLine: 3, endLine: 4, title: 'Off-by-one: loop reads past the end of the xs array', severity: 'high' as const };
    const c = { ...base, startLine: 7, endLine: 7, title: 'half() rounds', category: 'style' as const };
    const out = dedupeFindings([a, b, c]);
    expect(out.map((f) => [f.startLine, f.severity])).toEqual([[3, 'high'], [7, 'high']]);
  });

  it('reads findings written as JSON by models without tools (codex and OCR shapes)', () => {
    const text = 'Here you go:\n```json\n{"findings": [{"title": "[P1] Divide by zero", "body": "Empty input divides by 0.", "confidence_score": 0.8, "code_location": {"absolute_file_path": "src/math.ts", "line_range": {"start": 4, "end": 4}}}, {"path": "src/math.ts", "start_line": 2, "content": "unused", "severity": "minor", "category": "maintainability"}]}\n```';
    const f = findingsFromText(text, 1);
    expect(f.map((x) => [x.title, x.severity, x.startLine, x.category])).toEqual([
      ['Divide by zero', 'high', 4, 'bug'],
      ['unused', 'low', 2, 'maintainability'],
    ]);
  });
});

describe('rules and outputs', () => {
  it('picks language checklists and path-scoped project rules', () => {
    expect(checklistsFor(['a.py', '.github/workflows/ci.yml']).map((c) => c.name)).toEqual(['Python', 'GitHub Actions', 'Config / data files']);
    const root = join(process.cwd(), 'node_modules', '.tmp-review-rules');
    mkdirSync(join(root, '.kronos', 'review'), { recursive: true });
    writeFileSync(join(root, 'REVIEW.md'), 'Money is always integer cents.');
    writeFileSync(join(root, 'AGENTS.md'), '# Setup\nnpm i\n\n## Conventions\nNever log tokens.\n');
    writeFileSync(join(root, '.kronos', 'review', 'api.md'), '---\npaths: ["src/api/**"]\n---\nEvery handler checks auth.');
    const rules = loadProjectRules(root);
    expect(rules.map((r) => r.source)).toEqual(['REVIEW.md', 'AGENTS.md', '.kronos/review/api.md']);
    expect(rules[1]!.text).toContain('Never log tokens');
    expect(rules[1]!.text).not.toContain('npm i');
    expect(rulesFor(rules, ['src/ui/a.ts']).map((r) => r.source)).toEqual(['REVIEW.md', 'AGENTS.md']);
    expect(rulesFor(rules, ['src/api/users.ts']).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------

let env: TestEnv;
beforeEach(async () => {
  env = await makeRuntime();
});
afterEach(async () => {
  await env.cleanup();
});

const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
const inject = (provider: Provider) => (env.rt.providers as unknown as { cache: Map<string, Provider> }).cache.set('kronos', provider);
const git = (...args: string[]) => execFileSync('git', args, { cwd: env.workspace, stdio: 'pipe' }).toString();

describe('review engine', () => {
  it('reviews a branch, places and fact-checks findings, and writes a pull request review', async () => {
    const ws = env.workspace;
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'math.ts'), 'export function average(xs: number[]): number {\n  if (xs.length === 0) return 0;\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(ws, 'src', 'math.ts'), 'export function average(xs: number[]): number {\n  let sum = 0;\n  for (let i = 0; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\n\nexport const half = (x: number) => x / 2;\n');
    writeFileSync(join(ws, 'src', 'math.test.ts'), "import { average } from './math';\ntest('avg', () => expect(average([2, 4])).toBe(3));\n");
    git('add', '.');
    git('commit', '-qm', 'change');

    const calls: string[] = [];
    inject({
      id: 'kronos',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (req.system.startsWith('You are the fact-checker')) {
          calls.push('verify');
          const text = JSON.stringify({
            results: [
              { id: 'F1', verdict: 'keep', ground: null, severity: null, reason: 'i <= length reads xs[length]' },
              // ids follow severity order: F2 is the security finding, F3 the style one
              { id: 'F2', verdict: 'drop', ground: 'D', reason: 'not allowed for security' },
              { id: 'F3', verdict: 'drop', ground: 'D', reason: 'arrow style is a matter of taste' },
            ],
          });
          return { parts: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: 'scripted' };
        }
        const results = req.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result').length;
        calls.push(`review:${results}`);
        const call = (id: string, name: string, input: Record<string, unknown>): ToolCallPart => ({ type: 'tool_call', id, name, input });
        if (results === 0) {
          return {
            parts: [
              call('c1', 'review_comment', { path: 'src/math.ts', start_line: 99, existing_code: 'for (let i = 0; i <= xs.length; i++) sum += xs[i];', title: 'Loop reads one past the end', body: '`i <= xs.length` reads `xs[xs.length]` (undefined), so the sum is NaN.', severity: 'high', category: 'bug', confidence: 0.95, suggestion: '  for (let i = 0; i < xs.length; i++) sum += xs[i];' }),
              call('c2', 'review_comment', { path: 'math.ts', start_line: 7, title: 'Prefer a function declaration', body: 'Style.', severity: 'low', category: 'style' }),
              call('c3', 'review_comment', { path: 'src/math.ts', start_line: 4, existing_code: 'return sum / xs.length;', title: 'Division by zero exposes NaN to callers', body: 'Empty input returns NaN.', severity: 'medium', category: 'security' }),
              call('c4', 'review_comment', { path: 'src/other.ts', start_line: 1, title: 'x', body: 'y', severity: 'low' }),
            ],
            stopReason: 'tool_use',
            usage,
            model: 'scripted',
          };
        }
        if (results === 4) return { parts: [call('d1', 'review_done', { reviewed_files: ['src/math.ts'], verdict: 'incorrect', summary: 'average() is broken for every input.' })], stopReason: 'tool_use', usage, model: 'scripted' };
        if (results === 5) return { parts: [call('d2', 'review_done', { reviewed_files: ['src/math.ts', 'src/math.test.ts'], verdict: 'incorrect', summary: 'average() is broken for every input.' })], stopReason: 'tool_use', usage, model: 'scripted' };
        return { parts: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);

    const progress: string[] = [];
    const r = await env.rt.review.run({ cwd: ws, spec: { kind: 'range', base: 'main' }, onProgress: (p) => progress.push(p.stage) });

    // c4 was rejected by the tool (not a changed file), review_done first asked for the test file
    expect(calls.filter((c) => c.startsWith('review')).length).toBe(4);
    expect([...r.reviewed].sort()).toEqual(['src/math.test.ts', 'src/math.ts']);
    expect(r.groups).toBe(1);
    expect(r.findings.map((f) => [f.title, f.startLine, f.severity, f.verification?.verdict])).toEqual([
      ['Loop reads one past the end', 3, 'high', 'confirmed'],
      ['Division by zero exposes NaN to callers', 4, 'medium', 'uncertain'],
    ]);
    // the style finding was refuted on ground D; the security one cannot be dropped on D
    expect(r.dropped.map((d) => d.reason)).toEqual(['refuted (D): arrow style is a matter of taste']);
    expect(r.verdict).toBe('incorrect');
    expect(r.notes).toEqual(['average() is broken for every input.']);
    expect(r.headSha).toBe(git('rev-parse', 'HEAD').trim());
    expect(progress).toEqual(['diff', 'group', 'activity', 'activity', 'activity', 'group', 'verify', 'done']);
    // reviewer sessions are filed under a (hidden) review session
    const parent = env.rt.sessions.get(r.sessionId!)!;
    expect(parent.archived).toBe(true);
    expect(env.rt.sessions.list({ includeChildren: true, includeArchived: true }).filter((s) => s.parentId === parent.id).length).toBe(1);

    const gh = githubReview(r, { requestChanges: true });
    expect(gh.event).toBe('REQUEST_CHANGES');
    expect(gh.commit_id).toBe(r.headSha);
    expect(gh.comments[0]).toMatchObject({ path: 'src/math.ts', line: 3, side: 'RIGHT' });
    expect(gh.comments[0]!.body).toContain('```suggestion\n  for (let i = 0; i < xs.length; i++) sum += xs[i];\n```');
    const sarif = JSON.parse(formatSarif(r));
    expect(sarif.runs[0].results[0]).toMatchObject({ level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/math.ts' }, region: { startLine: 3 } } }] });
  });

  it('reviews uncommitted and untracked changes, and reports an empty change', async () => {
    const ws = env.workspace;
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeFileSync(join(ws, 'a.py'), 'x = 1\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    let r = await env.rt.review.run({ cwd: ws, spec: { kind: 'workspace' } });
    expect(r.summary).toMatch(/No changes found/);
    writeFileSync(join(ws, 'a.py'), 'x = 2\n');
    writeFileSync(join(ws, 'b.py'), 'def f(a=[]):\n    a.append(1)\n    return a\n');
    inject({
      id: 'kronos',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (req.system.startsWith('You are the fact-checker')) return { parts: [{ type: 'text', text: 'not json at all' }], stopReason: 'end_turn', usage, model: 'scripted' };
        // a model without tool calling answers with JSON text
        const text = '{"findings": [{"path": "b.py", "start_line": 1, "existing_code": "def f(a=[]):", "title": "Mutable default argument", "body": "The list is shared between calls.", "severity": "medium", "category": "bug", "confidence": 0.9}], "verdict": "correct", "summary": "ok"}';
        return { parts: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    r = await env.rt.review.run({ cwd: ws, spec: { kind: 'workspace' } });
    expect(r.reviewed.sort()).toEqual(['a.py', 'b.py']);
    expect(r.findings.map((f) => [f.path, f.startLine, f.verification?.verdict])).toEqual([['b.py', 1, 'uncertain']]);
    expect(r.verdict).toBe('correct');
  });
});

describe('/review command', () => {
  it('is a built-in slash command that asks for the code_review tool', async () => {
    expect(env.rt.commands().find((c) => c.name === 'review')).toMatchObject({ source: 'command' });
    const input = await env.rt.expandInput('/review #42');
    expect(JSON.stringify(input)).toContain('code_review');
    expect(JSON.stringify(input)).toContain('#42');
    expect(env.rt.tools.get('code_review')?.toolset).toBe('review');
  });
});

describe('full-file scan', () => {
  it('reviews whole files without a diff, and previews without a model', async () => {
    const ws = env.workspace;
    mkdirSync(join(ws, 'lib'));
    writeFileSync(join(ws, 'lib', 'a.py'), 'def f(items=[]):\n    items.append(1)\n    return items\n');
    writeFileSync(join(ws, 'lib', 'b.py'), 'x = 1\n');
    writeFileSync(join(ws, 'package-lock.json'), '{}');
    const p = await env.rt.review.preview({ cwd: ws, spec: { kind: 'scan', paths: ['lib', 'package-lock.json'] } });
    expect(p.groups.flatMap((g) => g.files).sort()).toEqual(['lib/a.py', 'lib/b.py']);
    expect(p.skipped).toEqual([{ path: 'package-lock.json', reason: 'lock file' }]);
    let task = '';
    inject({
      id: 'kronos',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (req.system.startsWith('You are the fact-checker')) return { parts: [{ type: 'text', text: '{"results": [{"id": "F1", "verdict": "drop", "ground": "C", "reason": "untouched"}]}' }], stopReason: 'end_turn', usage, model: 'scripted' };
        task ||= JSON.stringify(req.messages);
        const text = '{"findings": [{"path": "lib/a.py", "start_line": 1, "existing_code": "def f(items=[]):", "title": "Mutable default argument", "body": "Shared between calls.", "severity": "medium", "category": "bug"}], "verdict": "correct", "summary": "ok"}';
        return { parts: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const r = await env.rt.review.run({ cwd: ws, spec: { kind: 'scan', paths: ['lib'] } });
    expect(task).toContain('This is a full scan, not a change');
    // ground C ("code this change did not touch") cannot drop a finding in a scan
    expect(r.findings.map((f) => [f.path, f.startLine, f.inDiff])).toEqual([['lib/a.py', 1, true]]);
  });
});
