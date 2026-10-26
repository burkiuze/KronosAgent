import { isAbsolute, relative, resolve } from 'node:path';
import type { PermissionMode, ToolRisk } from '../types.js';
import type { KronosConfig } from '../config/schema.js';
import { detectDangerous, isReadOnlyCommand } from './dangerous.js';
import { commandsOf } from './shellparse.js';
import { globToRegExp } from '../util/glob.js';
import { expandHome } from '../config/paths.js';

export interface PermissionCheck {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
  dangerous?: boolean;
  /** rule string that would allow this call ("shell(git push*)") */
  suggestedRule?: string;
}

export interface ToolCallDescriptor {
  name: string;
  toolset: string;
  risk: ToolRisk;
  input: Record<string, unknown>;
  cwd: string;
  /** commands run inside the OS sandbox (terminal.sandbox), which contains their effects */
  sandboxed?: boolean;
}

/** Extract the argument a rule pattern is matched against. */
export function primaryArg(name: string, input: Record<string, unknown>): string {
  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'name', 'code']) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  if (name === 'apply_patch' && typeof input.patch === 'string') return input.patch.slice(0, 200);
  return '';
}

function parseRule(rule: string): { tool: RegExp; arg?: RegExp } {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return { tool: /^$/ };
  const tool = globToRegExp((m[1] as string).trim(), { dot: true });
  const argPattern = m[2]?.trim();
  if (!argPattern) return { tool };
  // command patterns: "*" may span spaces and slashes
  const re = new RegExp(`^${argPattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return { tool, arg: re };
}

function argMatches(r: { arg?: RegExp }, arg: string): boolean {
  return !r.arg || r.arg.test(arg);
}

/**
 * Does a rule cover this call? For shell commands with an argument pattern the line is parsed and
 * every command in it must match on its own — `shell(git status*)` covers `git status -s` but not
 * `git status && rm -rf src`. Lines that cannot be judged (substitutions, subshells, sudo, writes
 * through redirections outside the project) are never covered by an allow pattern.
 * `mode: 'deny'` matches when any single command (or the whole line) matches.
 */
export function ruleMatches(rule: string, name: string, arg: string, mode: 'allow' | 'deny' = 'allow'): boolean {
  const r = parseRule(rule);
  if (!r.tool.test(name)) return false;
  if (!r.arg) return true;
  if (name !== 'shell' && name !== 'process') return r.arg.test(arg);
  const { commands, opaque, privileged, parsed } = commandsOf(arg);
  const lines = commands.map((c) => c.join(' '));
  if (mode === 'deny') return r.arg.test(arg.trim()) || lines.some((l) => argMatches(r, l));
  if (opaque || privileged || !lines.length) return false;
  const safeRedirects = parsed.redirects.every((d) => /^\d*[<]/.test(d.op) || /&$/.test(d.op) || d.target === '/dev/null' || (!!d.target && !d.target.startsWith('/') && !d.target.startsWith('~') && !d.target.split('/').includes('..')));
  return safeRedirects && lines.every((l) => argMatches(r, l));
}

/** Prefixes too broad to approve once for all: interpreters, shells and multi-purpose tools (as in Codex). */
const BROAD_PREFIXES = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'env', 'sudo', 'doas', 'xargs', 'eval', 'exec', 'git', 'rm', 'python', 'python3', 'py', 'pypy', 'pypy3',
  'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php', 'lua', 'julia', 'Rscript', 'osascript', 'powershell', 'pwsh', 'cmd', 'npx', 'pnpx', 'bunx',
  'npm run', 'pnpm run', 'yarn run', 'bun run', 'python -c', 'python3 -c', 'node -e', 'perl -e', 'ruby -e', 'php -r', 'deno eval', 'uv run', 'poetry run', 'cargo run', 'go run',
  'docker run', 'docker exec', 'kubectl exec', 'ssh', 'curl', 'wget',
]);

/** The rule offered with "always allow": the first command's two leading words, never a too-broad prefix. */
export function suggestRule(name: string, arg: string): string {
  if (name !== 'shell' || !arg) return name;
  const { commands, opaque } = commandsOf(arg);
  const first = commands[0];
  if (!first?.length) return `shell(${arg.trim()})`;
  const prog = first[0]!.replace(/^.*\//, '');
  const two = [prog, ...first.slice(1, 2)].join(' ');
  // a multi-command or unparseable line, or a broad program: only this exact command line
  if (opaque || commands.length > 1) return `shell(${arg.trim()})`;
  if (BROAD_PREFIXES.has(two) || (first.length === 1 && BROAD_PREFIXES.has(prog))) return `shell(${first.join(' ')})`;
  if (BROAD_PREFIXES.has(prog)) {
    // `git commit …` → git commit*, but `python script.py` → exactly that
    return prog === 'git' && first[1] && !first[1].startsWith('-') ? `shell(git ${first[1]}*)` : `shell(${first.join(' ')})`;
  }
  return `shell(${two}*)`;
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'fs', 'notebook_edit']);

/**
 * Decides whether a tool call runs, asks the user, or is refused.
 *  - plan:      read-only; anything that changes state is refused
 *  - ask:       reads + web run freely; writes, commands and outbound actions ask
 *  - auto-edit: file edits inside the workspace run freely; commands still ask
 *  - yolo:      everything runs, except dangerous commands (configurable)
 * Deny rules always win; allow rules (config or "allow for session") skip the prompt.
 */
export class PermissionPolicy {
  private sessionAllows: string[] = [];

  constructor(private safety: KronosConfig['safety']) {}

  update(safety: KronosConfig['safety']): void {
    this.safety = safety;
  }

  allowForSession(rule: string): void {
    if (!this.sessionAllows.includes(rule)) this.sessionAllows.push(rule);
  }

  sessionRules(): string[] {
    return [...this.sessionAllows];
  }

  private isProtected(path: string, cwd: string): boolean {
    const abs = resolve(cwd, expandHome(path));
    return this.safety.protectedPaths.some((p) => globToRegExp(resolve(expandHome(p)), { dot: true }).test(abs));
  }

  private insideWorkspace(path: string, cwd: string): boolean {
    const abs = resolve(cwd, expandHome(path));
    const rel = relative(cwd, abs);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  check(call: ToolCallDescriptor, mode: PermissionMode): PermissionCheck {
    const arg = primaryArg(call.name, call.input);
    const suggestedRule = suggestRule(call.name, arg);

    for (const rule of this.safety.deny) {
      if (ruleMatches(rule, call.name, arg, 'deny')) return { action: 'deny', reason: `blocked by deny rule "${rule}"` };
    }

    const dangerous = call.name === 'shell' || call.name === 'execute_code' ? detectDangerous(String(call.input.command ?? call.input.code ?? '')) : undefined;
    if (dangerous) {
      if (this.safety.dangerousCommands === 'block') return { action: 'deny', reason: `dangerous command blocked: ${dangerous}`, dangerous: true };
      if (this.safety.dangerousCommands === 'ask' && mode !== 'plan') return { action: 'ask', reason: `dangerous command: ${dangerous}`, dangerous: true, suggestedRule };
    }

    const path = typeof call.input.path === 'string' ? call.input.path : typeof call.input.file_path === 'string' ? call.input.file_path : undefined;
    const writes = WRITE_TOOLS.has(call.name) || call.risk === 'write';
    if (writes && path) {
      if (this.isProtected(path, call.cwd)) return { action: 'ask', reason: `"${path}" is a protected path`, suggestedRule };
      if (this.safety.workspaceOnly && !this.insideWorkspace(path, call.cwd)) {
        return { action: 'deny', reason: `"${path}" is outside the workspace (safety.workspaceOnly)` };
      }
    }

    if (mode === 'plan') {
      if (call.risk === 'read' || call.risk === 'network') return { action: 'allow', reason: 'read-only' };
      if (call.name === 'shell' && isReadOnlyCommand(String(call.input.command ?? ''))) return { action: 'allow', reason: 'read-only command' };
      return { action: 'deny', reason: 'Plan mode is read-only. Finish investigating, then call exit_plan_mode with your plan for approval.' };
    }

    for (const rule of [...this.safety.allow, ...this.sessionAllows]) {
      if (ruleMatches(rule, call.name, arg)) return { action: 'allow', reason: `allowed by rule "${rule}"` };
    }
    if (dangerous && this.safety.dangerousCommands === 'allow') return { action: 'allow', reason: 'dangerous commands allowed by config', dangerous: true };

    switch (call.risk) {
      case 'read':
      case 'network':
        return { action: 'allow', reason: call.risk };
      case 'write':
        if (mode === 'yolo') return { action: 'allow', reason: 'yolo mode' };
        if (mode === 'auto-edit' && (!path || this.insideWorkspace(path, call.cwd))) return { action: 'allow', reason: 'auto-edit mode' };
        return { action: 'ask', reason: path ? `modify ${path}` : 'modify files', suggestedRule };
      case 'execute':
        if (mode === 'yolo') return { action: 'allow', reason: 'yolo mode' };
        if (call.name === 'shell' && isReadOnlyCommand(String(call.input.command ?? ''))) return { action: 'allow', reason: 'read-only command' };
        // like Codex's on-request policy: inside the sandbox a command cannot change anything
        // outside the project, so auto-edit lets it run (dangerous ones were handled above)
        if (mode === 'auto-edit' && call.sandboxed && (call.name === 'shell' || call.name === 'execute_code')) return { action: 'allow', reason: 'runs in the sandbox' };
        return { action: 'ask', reason: 'run a command', suggestedRule };
      case 'external':
      default:
        if (mode === 'yolo') return { action: 'allow', reason: 'yolo mode' };
        return { action: 'ask', reason: 'perform an outbound action', suggestedRule };
    }
  }
}
