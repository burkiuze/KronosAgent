import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A command that tells whether the project is in a good state. */
export interface ProjectCheck {
  /** test | typecheck | lint | build (or a Makefile/script name) */
  name: string;
  command: string;
  /** where it was found: package.json, pyproject.toml, Cargo.toml, … */
  source: string;
}

const NO_TEST = /no test specified/i;

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function nodeRunner(cwd: string): { run: (script: string) => string; test: string } {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return { run: (s) => `pnpm run ${s}`, test: 'pnpm test' };
  if (existsSync(join(cwd, 'yarn.lock'))) return { run: (s) => `yarn ${s}`, test: 'yarn test' };
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return { run: (s) => `bun run ${s}`, test: 'bun test' };
  return { run: (s) => `npm run ${s}`, test: 'npm test' };
}

/**
 * Finds the project's own test / typecheck / lint / build commands. Knowing exactly how a
 * project verifies itself is the kind of information that changes an agent's results more than
 * a bigger budget does, so these go into the system prompt and drive the verify tool.
 */
export function detectProjectChecks(cwd: string): ProjectCheck[] {
  const checks: ProjectCheck[] = [];
  const add = (name: string, command: string, source: string) => {
    if (!checks.some((c) => c.name === name)) checks.push({ name, command, source });
  };

  const pkg = readJson(join(cwd, 'package.json'));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const runner = nodeRunner(cwd);
    const pick = (names: string[]) => names.find((n) => typeof scripts[n] === 'string');
    const type = pick(['typecheck', 'type-check', 'check-types', 'tsc', 'types']);
    if (type) add('typecheck', runner.run(type), 'package.json');
    const lint = pick(['lint', 'eslint']);
    if (lint) add('lint', runner.run(lint), 'package.json');
    if (scripts.test && !NO_TEST.test(scripts.test)) add('test', runner.test, 'package.json');
    if (scripts.build) add('build', runner.run('build'), 'package.json');
  }

  const pyproject = read(join(cwd, 'pyproject.toml'));
  const isPython = pyproject || existsSync(join(cwd, 'setup.py')) || existsSync(join(cwd, 'requirements.txt'));
  if (isPython) {
    const src = 'pyproject.toml';
    if (pyproject.includes('mypy')) add('typecheck', 'mypy .', src);
    if (pyproject.includes('ruff')) add('lint', 'ruff check .', src);
    if (pyproject.includes('pytest') || existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'tests')) || existsSync(join(cwd, 'conftest.py')))
      add('test', 'python -m pytest -q', existsSync(join(cwd, 'pytest.ini')) ? 'pytest.ini' : src);
  }

  if (existsSync(join(cwd, 'Cargo.toml'))) {
    add('typecheck', 'cargo check --all-targets', 'Cargo.toml');
    add('lint', 'cargo clippy --all-targets -- -D warnings', 'Cargo.toml');
    add('test', 'cargo test', 'Cargo.toml');
  }

  if (existsSync(join(cwd, 'go.mod'))) {
    add('typecheck', 'go vet ./...', 'go.mod');
    add('test', 'go test ./...', 'go.mod');
    add('build', 'go build ./...', 'go.mod');
  }

  if (existsSync(join(cwd, 'deno.json')) || existsSync(join(cwd, 'deno.jsonc'))) {
    add('typecheck', 'deno check .', 'deno.json');
    add('lint', 'deno lint', 'deno.json');
    add('test', 'deno test', 'deno.json');
  }

  if (existsSync(join(cwd, 'Gemfile')) && existsSync(join(cwd, 'spec'))) add('test', 'bundle exec rspec', 'Gemfile');
  if (existsSync(join(cwd, 'mix.exs'))) add('test', 'mix test', 'mix.exs');
  if (existsSync(join(cwd, 'pom.xml'))) add('test', 'mvn -q test', 'pom.xml');
  if (existsSync(join(cwd, 'gradlew'))) add('test', './gradlew test', 'gradlew');

  // a Makefile's own targets fill whatever is still missing
  const makefile = read(join(cwd, 'Makefile'));
  if (makefile) {
    for (const [name, targets] of [
      ['test', ['test', 'check']],
      ['lint', ['lint']],
      ['typecheck', ['typecheck']],
      ['build', ['build']],
    ] as const) {
      const target = targets.find((t) => new RegExp(`^${t}\\s*:`, 'm').test(makefile));
      if (target) add(name, `make ${target}`, 'Makefile');
    }
  }

  const order = ['typecheck', 'lint', 'test', 'build'];
  return checks.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** One line for the system prompt: "typecheck `npm run typecheck` · test `npm test` …". */
export function describeChecks(checks: ProjectCheck[]): string {
  return checks.map((c) => `${c.name} \`${c.command}\``).join(' · ');
}

const FAILURE_LINE = /(\bFAIL(ED)?\b|\bError\b|error(\[\w+\])?:|✗|✕|×|AssertionError|panicked at|Traceback|\bfailed\b|not ok \d)/;

/** The lines of a failing check's output most worth reading first. */
export function failureHighlights(output: string, max = 25): string[] {
  const lines = output.split('\n');
  const hits: string[] = [];
  for (const line of lines) {
    if (FAILURE_LINE.test(line) && line.trim().length < 400) hits.push(line.trimEnd());
    if (hits.length >= max) break;
  }
  return hits;
}
