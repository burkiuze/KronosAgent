import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspManager } from '../src/tools/lsp.js';

const m = new LspManager();
const ws = mkdtempSync(join(tmpdir(), 'kronos-lsp-'));

describe.skipIf(!m.available(join(ws, 'x.py')))('language-server diagnostics delta (pyright)', () => {
  it('reports only the errors an edit introduced', async () => {
    const f = join(ws, 'b.py');
    const before = 'def f(x: int) -> int:\n    return x\n\nprint(already_broken)\n';
    const after = `${before}y: int = f("s")\n`;
    writeFileSync(f, after);
    const r = await m.introduced(f, before, after, ws, 15_000);
    m.close();
    expect(r?.server).toBe('pyright');
    expect(r?.errors.map((e) => e.line)).toEqual([5]);
    expect(r?.errors[0]?.message).toMatch(/cannot be assigned to parameter "x"/);
  }, 60_000);
});
