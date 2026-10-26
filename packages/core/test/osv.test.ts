import { describe, expect, it } from 'vitest';
import { OsvChecker, packagesInCommand } from '../src/safety/osv.js';

describe('packages a command installs', () => {
  it.each([
    ['npm install left-pad@1.3.0 -D', [{ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }]],
    ['pnpm add @scope/pkg@^2 lodash', [{ ecosystem: 'npm', name: '@scope/pkg', version: undefined }, { ecosystem: 'npm', name: 'lodash', version: undefined }]],
    ['npx -y create-vite@5.0.0 app', [{ ecosystem: 'npm', name: 'create-vite', version: '5.0.0' }]],
    ['pip install "requests[socks]==2.31.0" --index-url https://x', [{ ecosystem: 'PyPI', name: 'requests', version: '2.31.0' }]],
    ['uv pip install Django', [{ ecosystem: 'PyPI', name: 'django', version: undefined }]],
    ['uvx ruff check .', [{ ecosystem: 'PyPI', name: 'ruff', version: undefined }]],
    ['cd app && npm i ./local-pkg ../x git+https://github.com/a/b', []],
    ['npm install', []],
    ['pip install -r requirements.txt', []],
    ['npm test', []],
  ])('%s', (cmd, expected) => expect(packagesInCommand(cmd)).toEqual(expected));
});

describe('OSV malware check', () => {
  const fake = (vulns: Record<string, { id: string; summary?: string }[]>, calls: string[]) =>
    (async (_url: string, init: { body: string }) => {
      const q = JSON.parse(init.body) as { package: { name: string } };
      calls.push(q.package.name);
      if (q.package.name === 'offline-pkg') throw new Error('network down');
      return { ok: true, json: async () => ({ vulns: vulns[q.package.name] ?? [] }) };
    }) as never;

  it('blocks malware advisories only, caches verdicts and fails open', async () => {
    const calls: string[] = [];
    const osv = new OsvChecker(undefined, fake({ 'reqeusts': [{ id: 'MAL-2024-1', summary: 'Malicious typosquat of requests' }], lodash: [{ id: 'GHSA-xxxx', summary: 'prototype pollution' }] }, calls));
    const hit = await osv.checkCommand('pip install reqeusts');
    expect(hit).toMatchObject({ ids: ['MAL-2024-1'], pkg: { name: 'reqeusts' } });
    expect(await osv.checkCommand('npm i lodash')).toBeNull(); // ordinary CVEs are not blocked
    expect(await osv.checkCommand('npm i offline-pkg')).toBeNull(); // fail-open
    await osv.checkCommand('pip install reqeusts');
    expect(calls.filter((c) => c === 'reqeusts')).toHaveLength(1); // cached
  });
});
