import { extname, basename } from 'node:path';
import { effectiveCommands, parseShell } from '../safety/shellparse.js';

/**
 * What counts as proof that work is correct (after Hermes' verification_evidence): the project's
 * own checks run from the shell count like the verify tool — when their exit status is really
 * theirs. `npm test | tail -20` exits with tail's status, so a pass there proves nothing.
 */

const NON_CODE_EXT = new Set(['.md', '.markdown', '.mdx', '.rst', '.txt', '.text', '.adoc', '.org', '.log', '.csv', '.tsv']);
const NON_CODE_NAMES = new Set(['license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'codeowners']);

/** Documentation and prose: nothing to run after editing them. */
export function isNonCodePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return NON_CODE_EXT.has(ext) || (!ext && NON_CODE_NAMES.has(basename(path).toLowerCase()));
}

export type CheckKind = 'test' | 'lint' | 'typecheck' | 'build';

/** The kind of check a single command runs, if it is one. */
export function checkKind(words: string[]): CheckKind | undefined {
  const [cmd = '', a = '', b = ''] = words.map((w, i) => (i === 0 ? w.replace(/^.*\//, '').replace(/\.exe$/i, '') : w));
  const runner = ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd);
  const script = runner ? (a === 'run' || a === 'run-script' ? b : a) : '';
  const byName = (name: string): CheckKind | undefined =>
    /^(test|tests|spec|e2e|test:\S+)$/.test(name) ? 'test' : /lint|eslint|ruff|clippy/.test(name) ? 'lint' : /typecheck|type-check|tsc|types|check/.test(name) ? 'typecheck' : /^build/.test(name) ? 'build' : undefined;
  if (runner) return byName(script);
  if (['pytest', 'py.test', 'vitest', 'jest', 'mocha', 'ava', 'rspec', 'phpunit', 'tox', 'nox', 'ctest'].includes(cmd)) return 'test';
  if (/^python\d*(\.\d+)?$/.test(cmd) && a === '-m' && /^(pytest|unittest|mypy|ruff|pyright)$/.test(b)) return b === 'pytest' || b === 'unittest' ? 'test' : b === 'ruff' ? 'lint' : 'typecheck';
  if (['uv', 'poetry', 'pipenv', 'hatch', 'pdm'].includes(cmd) && a === 'run') return checkKind(words.slice(2));
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') return checkKind(words.slice(1).filter((w) => !w.startsWith('-')));
  if (['tsc', 'mypy', 'pyright', 'basedpyright', 'flow'].includes(cmd)) return 'typecheck';
  if (['eslint', 'ruff', 'flake8', 'pylint', 'golangci-lint', 'rubocop', 'biome', 'shellcheck', 'stylelint'].includes(cmd)) return 'lint';
  if (cmd === 'cargo') return a === 'test' || a === 'nextest' ? 'test' : a === 'clippy' ? 'lint' : a === 'check' ? 'typecheck' : a === 'build' ? 'build' : undefined;
  if (cmd === 'go') return a === 'test' ? 'test' : a === 'vet' ? 'lint' : a === 'build' ? 'build' : undefined;
  if (['make', 'just', 'task'].includes(cmd)) return byName(a);
  if (['mvn', 'gradle', './gradlew', 'gradlew'].includes(cmd)) return /test|verify|check/.test(words.slice(1).join(' ')) ? 'test' : /build|compile|assemble/.test(words.slice(1).join(' ')) ? 'build' : undefined;
  if (cmd === 'dotnet') return a === 'test' ? 'test' : a === 'build' ? 'build' : undefined;
  if (['deno', 'bun'].includes(cmd) && a === 'test') return 'test';
  return undefined;
}

export interface CheckRun {
  kind: CheckKind;
  /** the exit status belongs to the check (not masked by a later pipeline stage) */
  attributable: boolean;
  /** the command that hides it, e.g. "tail" */
  maskedBy?: string;
}

/** Whether a shell line runs a project check, and whether its exit status can be trusted. */
export function checkRun(command: string): CheckRun | undefined {
  const { commands, ops } = parseShell(command);
  const idx = commands.findIndex((c) => checkKind(effectiveCommands(c).commands[0] ?? c) !== undefined);
  if (idx < 0) return undefined;
  const kind = checkKind(effectiveCommands(commands[idx] as string[]).commands[0] ?? (commands[idx] as string[])) as CheckKind;
  // the pipeline the check is in: a later stage decides its exit status
  let end = idx;
  while (ops[end] === '|') end++;
  const pipefail = /set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail/.test(command);
  const masked = end > idx && !pipefail;
  // `check || true` (or `|| :`) turns a failure into success
  const swallowed = ops[end] === '||' && /^(true|:)$/.test((commands[end + 1] ?? [])[0] ?? '');
  // in `check; other` the line's status is the last command's
  const later = ops.slice(end).some((o) => o === ';' || o === '&');
  const maskedBy = swallowed ? '|| true' : masked ? (commands[end] as string[])[0] : later ? (commands[commands.length - 1] as string[])[0] : undefined;
  return { kind, attributable: !maskedBy, maskedBy };
}
