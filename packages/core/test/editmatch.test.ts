import { describe, expect, it } from 'vitest';
import { alreadyApplied, correctEscapeDrift, locateEdit } from '../src/util/editmatch.js';

const apply = (src: string, old: string, next: string) => {
  const r = locateEdit(src, old, next);
  if ('error' in r) return { error: r.error };
  if (r.matches.length !== 1) return { count: r.matches.length };
  const m = r.matches[0]!;
  return { text: src.slice(0, m.start) + m.replacement + src.slice(m.end), strategy: m.strategy, note: m.note };
};

const SRC = 'class A {\n    run() {\n        if (x) {\n            go("now");\n        }\n    }\n}\n';

describe('edit matching for slightly-off copies', () => {
  it('matches exactly when it can', () => {
    expect(apply(SRC, 'go("now");', 'go("later");')).toMatchObject({ strategy: 'exact', note: undefined });
  });

  it('re-indents the replacement when the model dropped the indentation', () => {
    const r = apply(SRC, 'if (x) {\n    go("now");\n}', 'if (x) {\n    go("now");\n    log();\n}');
    expect(r).toMatchObject({ strategy: 'ignoring_indentation' });
    expect(r.text).toBe('class A {\n    run() {\n        if (x) {\n            go("now");\n            log();\n        }\n    }\n}\n');
    expect(r.note).toMatch(/re-indented/);
  });

  it('collapses inner whitespace and typographic quotes', () => {
    expect(apply(SRC, 'if  (x)   {', 'if (y) {')).toMatchObject({ strategy: 'ignoring_whitespace' });
    expect(apply(SRC, 'go(“now”);', 'go("x");')).toMatchObject({ strategy: 'after_unicode_normalization' });
  });

  it('corrects JSON escape drift only when the corrected text is in the file', () => {
    expect(correctEscapeDrift(SRC, 'go(\\"now\\");', 'go(\\"later\\");')).toEqual({ old: 'go("now");', next: 'go("later");', note: 'read \\" as " (escape drift in the arguments)' });
    const re = 'const re = /a\\d+/;\n';
    expect(correctEscapeDrift(re, 'a\\\\d+', 'b')).toMatchObject({ old: 'a\\d+', next: 'b' });
    expect('error' in correctEscapeDrift(re, 'a\\\\d+', 'b\\\\w')).toBe(true);
    // a file that really contains \" is left alone
    expect(correctEscapeDrift('s = "say \\"hi\\""', 'say \\"hi\\"', 'x')).toEqual({ old: 'say \\"hi\\"', next: 'x' });
  });

  it('turns literal \\n escapes into line breaks', () => {
    expect(apply('a\nb\n', 'a\\nb', 'c')).toMatchObject({ text: 'c\n', strategy: 'after_unescaping' });
  });

  it('anchors on first and last line when the middle is only similar, if unique', () => {
    const src = 'function f() {\n  const total = items.reduce((a, b) => a + b, 0);\n  return total;\n}\n';
    const r = apply(src, 'function f() {\n  const total = items.reduce((acc, b) => acc + b, 0);\n  return total;\n}', 'function f() {\n  return sum(items);\n}');
    expect(r).toMatchObject({ strategy: 'by_first_and_last_line', text: 'function f() {\n  return sum(items);\n}\n' });
    expect(apply(src, 'function f() {\n  something entirely different here\n  return total;\n}', 'x')).toEqual({ count: 0 });
  });

  it('reports ambiguity and recognizes a re-sent edit', () => {
    expect(apply('x();\nx();\n', '  x();', 'y();')).toEqual({ count: 2 });
    expect(alreadyApplied('go("later");', 'go("now");', 'go("later");')).toBe(true);
  });
});
