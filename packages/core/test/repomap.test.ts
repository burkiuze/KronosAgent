import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRepoMap } from '../src/tools/repomap.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kronos-map-'));
  write(
    'src/auth/token.ts',
    `import { db } from '../db';\n\nexport interface TokenClaims {\n  sub: string;\n}\n\nexport function parseToken(raw: string): TokenClaims {\n  return JSON.parse(raw);\n}\n\nexport class TokenStore {\n  constructor(private ttl: number) {}\n\n  async save(token: string): Promise<{ ok: boolean }> {\n    return { ok: true };\n  }\n}\n\nexport const verify = async (t: string) => parseToken(t);\n`,
  );
  write('src/routes/login.ts', `import { parseToken, TokenStore } from '../auth/token';\nexport function login(raw: string) {\n  const store = new TokenStore(60);\n  return parseToken(raw);\n}\n`);
  write('src/routes/logout.ts', `import { parseToken } from '../auth/token';\nexport function logout(raw: string) {\n  return parseToken(raw);\n}\n`);
  write('scripts/report.py', `import os\n\nclass Report:\n    def __init__(self, path):\n        self.path = path\n\n    def render(self, rows):\n        return rows\n\ndef main():\n    Report('x').render([])\n`);
  write('cmd/server/main.go', `package main\n\ntype Server struct{}\n\nfunc (s *Server) Start(addr string) error {\n\treturn nil\n}\n\nfunc main() {}\n`);
  write('crates/core/src/lib.rs', `pub struct Engine;\n\nimpl Engine {\n    pub fn run(&self) -> u32 {\n        0\n    }\n}\n\npub(crate) async fn helper() {}\n`);
  write('node_modules/dep/index.js', 'export function shouldNotAppear() {}\n');
  write('src/auth/token.test.ts', `import { parseToken } from './token';\ntest('parses', () => parseToken('{}'));\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('repo map', () => {
  it('lists definitions with signatures across languages, skipping vendored code', async () => {
    const { text, files } = await buildRepoMap(root, { maxTokens: 4000 });
    expect(files).toBe(7);
    expect(text).toContain('src/auth/token.ts');
    expect(text).toMatch(/\d+: export function parseToken\(raw: string\): TokenClaims/);
    expect(text).toMatch(/\d+: export class TokenStore/);
    expect(text).toMatch(/ {4}\d+: async save\(token: string\): Promise<\{ ok: boolean \}>/);
    expect(text).toMatch(/\d+: export const verify = async/);
    expect(text).toMatch(/\d+: class Report:?/);
    expect(text).toMatch(/ {4}\d+: def render\(self, rows\)/);
    expect(text).toMatch(/\d+: func \(s \*Server\) Start\(addr string\) error/);
    expect(text).toMatch(/\d+: pub struct Engine/);
    expect(text).toMatch(/\d+: pub\(crate\) async fn helper\(\)/);
    expect(text).not.toContain('shouldNotAppear');
  });

  it('puts the code other files depend on first, and focus above that', async () => {
    const plain = await buildRepoMap(root, { maxTokens: 4000 });
    const order = (t: string) => t.split('\n').filter((l) => /^\S+\.\w+/.test(l));
    expect(order(plain.text)[0]).toBe('src/auth/token.ts');
    const focused = await buildRepoMap(root, { maxTokens: 4000, focus: ['Report'] });
    expect(order(focused.text)[0]).toBe('scripts/report.py');
  });

  it('stays within its budget and names the files it left out', async () => {
    const { text, shown } = await buildRepoMap(root, { maxTokens: 200 });
    expect(text.length).toBeLessThan(200 * 4 + 900);
    expect(shown).toBeLessThan(7);
    expect(text).toMatch(/Other files \(\d+\):/);
  });
});
