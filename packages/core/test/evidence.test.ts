import { describe, expect, it } from 'vitest';
import { checkKind, checkRun, isNonCodePath } from '../src/agent/evidence.js';

describe('verification evidence', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run lint', 'lint'],
    ['yarn typecheck', 'typecheck'],
    ['python3 -m pytest -q tests/test_a.py', 'test'],
    ['uv run pytest', 'test'],
    ['npx vitest run', 'test'],
    ['npx tsc --noEmit', 'typecheck'],
    ['cargo clippy -- -D warnings', 'lint'],
    ['go test ./...', 'test'],
    ['make test', 'test'],
    ['./gradlew test', 'test'],
    ['ls -la', undefined],
    ['npm install', undefined],
  ])('%s → %s', (cmd, kind) => expect(checkKind(cmd.split(' '))).toBe(kind));

  it('trusts an exit status only when it is the check\'s own', () => {
    expect(checkRun('npm test')).toEqual({ kind: 'test', attributable: true, maskedBy: undefined });
    expect(checkRun('cd app && npm test')).toMatchObject({ attributable: true });
    expect(checkRun('npm test 2>&1 | tail -20')).toMatchObject({ attributable: false, maskedBy: 'tail' });
    expect(checkRun('set -o pipefail; npm test | tail -20')).toMatchObject({ attributable: true });
    expect(checkRun('pytest || true')).toMatchObject({ attributable: false, maskedBy: '|| true' });
    expect(checkRun('pytest; echo done')).toMatchObject({ attributable: false, maskedBy: 'echo' });
    expect(checkRun('pytest && echo ok')).toMatchObject({ attributable: true });
    expect(checkRun('echo hi')).toBeUndefined();
  });

  it('knows documentation needs no test run', () => {
    expect(['README.md', 'docs/guide.rst', 'LICENSE', 'notes.txt'].every(isNonCodePath)).toBe(true);
    expect(['src/a.ts', 'Makefile', 'config.yaml'].some(isNonCodePath)).toBe(false);
  });
});
