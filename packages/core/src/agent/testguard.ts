/**
 * Notices edits that make tests pass by weakening them: assertions removed, tests skipped or
 * focused (`.only` silences the rest), test files deleted, trivially true assertions. Agents under
 * pressure to get a green run do this; the harness points it out in the edit's own result.
 */

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)s?\.[a-z]+$|_test\.(go|py|rs|exs?)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs|swift)$/i;

const SKIP =
  /\b(it|test|describe|context|suite)\.(skip|todo|only)\s*\(|\bx(it|test|describe)\s*\(|\bf(it|describe)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|expectedFailure)\b|\bpytest\.skip\s*\(|\bt\.Skip(Now|f)?\s*\(|#\[ignore\]|@(Disabled|Ignore)\b|\bskip\s*\(\s*["'`]/;

const ASSERT =
  /\b(expect|assert\w*|assertThat|should|XCTAssert\w*|self\.assert\w+|t\.(Error|Errorf|Fatal|Fatalf|Fail\w*)|require\.\w+|refute\w*)\s*[(.!]|\bassert\s|\bassert_(eq|ne)!|\bassert!/;

const TRIVIAL = /expect\(\s*(true|1)\s*\)\.(toBe|toEqual)\(\s*(true|1)\s*\)|\bassert\s+True\b|\bassert\s*\(\s*true\s*\)|assertTrue\(\s*true\s*\)/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, '/'));
}

/** What a unified diff does to weaken tests, one line per test file; empty when nothing. */
export function weakenedTests(diff: string): string[] {
  const out: string[] = [];
  let file = '';
  let deleted = false;
  let removedAsserts = 0;
  let addedAsserts = 0;
  let removedLines = 0;
  let addedLines = 0;
  const marks = new Set<string>();
  const flush = () => {
    if (file && isTestPath(file)) {
      const what: string[] = [];
      if (deleted && removedLines > 0) what.push('deletes the test file');
      else if (removedAsserts > addedAsserts) what.push(`removes ${removedAsserts - addedAsserts} assertion${removedAsserts - addedAsserts === 1 ? '' : 's'}`);
      what.push(...marks);
      if (what.length) out.push(`${file}: ${what.join(', ')}`);
    }
    deleted = false;
    removedAsserts = addedAsserts = removedLines = addedLines = 0;
    marks.clear();
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      flush();
      file = line.slice(4).replace(/^a\//, '').replace(/\t.*$/, '').trim();
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t.*$/, '').trim();
      if (target === '/dev/null') deleted = true;
      else file = target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) continue;
    const code = line.slice(1).replace(/\/\/.*$|#(?!\[).*$/, '');
    if (line.startsWith('-')) {
      removedLines++;
      if (ASSERT.test(code)) removedAsserts++;
    } else if (line.startsWith('+')) {
      addedLines++;
      if (TRIVIAL.test(code)) marks.add('adds an assertion that is always true');
      else if (ASSERT.test(code)) addedAsserts++;
      const skip = SKIP.exec(code);
      if (skip) marks.add(/only|\bf(it|describe)/.test(skip[0]) ? `focuses tests (${skip[0].replace(/\s*\($/, '')}) so the others do not run` : `skips tests (${skip[0].replace(/\s*\($/, '')})`);
    }
  }
  flush();
  return out;
}

export function weakenedTestsNote(found: string[]): string {
  return `\n\nNote: this edit weakens tests — ${found.join('; ')}. Tests define the expected behaviour: change them only when that behaviour was meant to change or the test itself is wrong; otherwise fix the code. If you keep this change, say in your answer which tests you changed and why.`;
}
