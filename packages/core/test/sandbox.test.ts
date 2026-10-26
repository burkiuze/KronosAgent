import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { detectSandbox, hostAllowed, hostMatches, isPrivateAddress, projectRoot, seatbeltProfile, writableRoots } from '@kronos/core';
import { makeRuntime, type TestEnv } from './helpers.js';

const cfg = { mode: 'workspace-write' as const, network: true, writable: [], fallback: 'refuse' as const };

describe('sandbox planning', () => {
  it('lets commands write only to the project, temp and configured directories', () => {
    // real path: on macOS the temp dir is under a symlink (/var -> /private/var) and roots are resolved
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kronos-sb-')));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'repo', 'src', 'deep'), { recursive: true });
    mkdirSync(join(root, 'cache'));
    expect(projectRoot(join(root, 'repo', 'src', 'deep'))).toBe(join(root, 'repo'));
    const roots = writableRoots(join(root, 'repo', 'src'), { ...cfg, writable: [join(root, 'cache'), join(root, 'missing')] });
    expect(roots).toContain(join(root, 'repo'));
    expect(roots).toContain(join(root, 'cache'));
    expect(roots).not.toContain(join(root, 'missing'));
    const ro = writableRoots(join(root, 'repo'), { ...cfg, mode: 'read-only' });
    expect(ro).not.toContain(join(root, 'repo'));
  });

  it('writes a Seatbelt profile that denies writes and, optionally, the network', () => {
    const p = seatbeltProfile(['/a', '/b'], false);
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain('(subpath (param "W0")) (subpath (param "W1"))');
    expect(p).toContain('(deny network-outbound (remote ip))');
    expect(seatbeltProfile(['/a'], true)).not.toContain('network');
  });
});

const engine = detectSandbox();
// the Landlock helper on Linux and Seatbelt on macOS (CI runs both)
const enforcing = 'engine' in engine && (engine.engine === 'kronos-sandbox' || engine.engine === 'seatbelt');
const linuxHelper = 'engine' in engine && engine.engine === 'kronos-sandbox';

describe.skipIf(!enforcing)(`sandboxed shell (${'engine' in engine ? engine.engine : 'none'})`, () => {
  let env: TestEnv;
  let outside: string;
  beforeEach(async () => {
    env = await makeRuntime({ terminal: { sandbox: { mode: 'workspace-write', network: false, writable: [], fallback: 'refuse' } } } as never);
    // temp is writable inside the sandbox, so "outside" lives in the repository's node_modules
    mkdirSync(join(process.cwd(), 'node_modules'), { recursive: true });
    outside = mkdtempSync(join(process.cwd(), 'node_modules', '.tmp-sandbox-outside-'));
  });
  afterEach(async () => {
    await env.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it('runs commands that stay in the workspace and stops the ones that do not', async () => {
    const run = (command: string) => env.rt.backend.exec(command, { cwd: env.workspace, timeoutMs: 20_000 });
    expect(env.rt.backend.describe()).toMatch(linuxHelper ? /sandboxed \(Landlock v\d+.*\): writes limited to the project and temp, no network/ : /sandboxed \(macOS Seatbelt\).*no network/);
    const ok = await run('echo inside > inside.txt && cat inside.txt && cat /etc/hosts > /dev/null && echo read-ok');
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain('read-ok');
    expect(readFileSync(join(env.workspace, 'inside.txt'), 'utf8')).toBe('inside\n');
    const bad = await run(`echo x > ${join(outside, 'escape.txt')}`);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.output).toMatch(/Permission denied|Operation not permitted/);
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
    // temp stays writable (compilers, package managers)
    expect((await run('f=$(mktemp) && echo t > "$f" && cat "$f"')).output).toContain('t');
    // no network: a TCP connection to anything fails
    const net = await run(`node -e "require('net').connect(9, '127.0.0.1').on('error', e => { console.log('blocked', e.code); }).on('connect', () => console.log('connected'))"`);
    expect(net.output).toMatch(/blocked (EACCES|EPERM|ECONNREFUSED|ENETUNREACH)/);
    // background processes are sandboxed too
    const p = env.rt.processes.start(`echo bg > ${join(outside, 'bg.txt')}; echo done`, env.workspace, undefined, undefined, env.rt.config.terminal.sandbox);
    for (let i = 0; i < 50 && env.rt.processes.list().find((x) => x.id === p.id)?.running; i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(outside, 'bg.txt'))).toBe(false);
    writeFileSync(join(outside, 'keep.txt'), 'untouched');
    expect((await run(`rm -f ${join(outside, 'keep.txt')}`)).exitCode).not.toBe(0);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('network allowlist', () => {
  it('matches domain patterns like Codex', () => {
    expect(hostMatches('registry.npmjs.org', 'registry.npmjs.org')).toBe(true);
    expect(hostMatches('api.github.com', '*.github.com')).toBe(true);
    expect(hostMatches('github.com', '*.github.com')).toBe(false);
    expect(hostMatches('github.com', '**.github.com')).toBe(true);
    expect(hostMatches('evilgithub.com', '**.github.com')).toBe(false);
    expect(hostMatches('anything.com', '*')).toBe(false);
    expect(hostAllowed('pypi.org', { allow: ['**.pypi.org'], deny: ['pypi.org'] }).ok).toBe(false);
    expect(['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '::1', 'fd00::1', '169.254.1.1'].every(isPrivateAddress)).toBe(true);
    expect(isPrivateAddress('140.82.112.3')).toBe(false);
  });
});

describe.skipIf(!linuxHelper || !(engine as { detail?: string }).detail?.includes('network rules'))('sandboxed network through the proxy', () => {
  let env: TestEnv;
  let server: Server;
  let port = 0;
  beforeEach(async () => {
    server = createServer((_q, r) => r.end('hello from the allowed host'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    env = await makeRuntime({ terminal: { sandbox: { mode: 'workspace-write', network: false, writable: [], fallback: 'refuse', allowDomains: ['127.0.0.1'] } } } as never);
  });
  afterEach(async () => {
    server.close();
    await env.cleanup();
  });

  it('lets commands reach allowed hosts only, and only through the proxy', async () => {
    const run = (command: string) => env.rt.backend.exec(command, { cwd: env.workspace, timeoutMs: 20_000 });
    expect(env.rt.backend.describe()).toMatch(/network only to 127\.0\.0\.1/);
    expect((await run(`curl -s http://127.0.0.1:${port}/`)).output).toContain('hello from the allowed host');
    const blocked = await run(`curl -s -i http://localhost:${port}/`);
    expect(blocked.output).toMatch(/403[\s\S]*not on the network allowlist/);
    // going around the proxy is not possible: only its port can be connected to
    const direct = await run(`node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => console.log('connected')).on('error', e => console.log('blocked', e.code))"`);
    expect(direct.output).toMatch(/blocked (EACCES|EPERM)/);
  });
});
