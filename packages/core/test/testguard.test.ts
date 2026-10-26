import { describe, expect, it } from 'vitest';
import { isTestPath, weakenedTests } from '../src/agent/testguard.js';
import { unifiedDiff } from '../src/util/diff.js';

describe('test weakening guard', () => {
  it('knows test files across languages', () => {
    for (const p of ['src/parse.test.ts', 'tests/test_api.py', 'pkg/server_test.go', 'src/__tests__/a.js', 'spec/user_spec.rb', 'app/src/test/java/FooTest.java']) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/parse.ts', 'src/testing.ts', 'docs/test-plan.md']) expect(isTestPath(p), p).toBe(false);
  });

  it('flags removed assertions, skips, focus, trivial asserts and deleted test files', () => {
    const before = "it('parses', () => {\n  expect(parse('1')).toBe(1);\n  expect(parse('x')).toBeNaN();\n});\n";
    expect(weakenedTests(unifiedDiff(before, "it('parses', () => {\n  expect(parse('1')).toBe(1);\n});\n", 'src/parse.test.ts'))).toEqual(['src/parse.test.ts: removes 1 assertion']);
    expect(weakenedTests(unifiedDiff(before, before.replace("it('parses'", "it.skip('parses'"), 'src/parse.test.ts'))[0]).toContain('skips tests (it.skip)');
    expect(weakenedTests(unifiedDiff(before, before.replace("it('parses'", "it.only('parses'"), 'src/parse.test.ts'))[0]).toContain('focuses tests (it.only)');
    expect(weakenedTests(unifiedDiff('def test_a():\n    assert f() == 2\n', '@pytest.mark.skip\ndef test_a():\n    assert True\n', 'tests/test_a.py'))[0]).toMatch(/removes 1 assertion|always true/);
    expect(weakenedTests(unifiedDiff('def test_a():\n    assert f() == 2\n', '@pytest.mark.skip\ndef test_a():\n    assert True\n', 'tests/test_a.py'))[0]).toContain('skips tests (@pytest.mark.skip)');
    expect(weakenedTests(`--- a/pkg/x_test.go\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-func TestX(t *testing.T) {\n-  t.Fatal("x")\n-}\n`)).toEqual(['pkg/x_test.go: deletes the test file']);
  });

  it('stays quiet for ordinary test work and for code files', () => {
    const before = "it('parses', () => {\n  expect(parse('1')).toBe(1);\n});\n";
    // a new test, a changed expectation, moved assertions
    expect(weakenedTests(unifiedDiff(before, before + "it('rejects', () => {\n  expect(() => parse('x')).toThrow();\n});\n", 'src/parse.test.ts'))).toEqual([]);
    expect(weakenedTests(unifiedDiff(before, before.replace('toBe(1)', 'toBe(2)'), 'src/parse.test.ts'))).toEqual([]);
    expect(weakenedTests(unifiedDiff('assert x\nassert y\n', 'assert y\nassert x\n', 'tests/test_b.py'))).toEqual([]);
    // assertions removed from application code are not test weakening
    expect(weakenedTests(unifiedDiff('assert(x > 0);\nrun();\n', 'run();\n', 'src/run.ts'))).toEqual([]);
  });
});
