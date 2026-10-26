/**
 * A small POSIX shell reader for permission decisions — the job tree-sitter-bash does in Codex.
 * It splits a command line into the simple commands it runs (`a && b | c; d`), resolves quotes
 * and escapes into plain words, and reports everything that makes a line impossible to judge
 * statically: command and process substitution, variable expansion, redirections, heredocs,
 * subshells, control flow. Callers treat such lines conservatively.
 */

export interface Redirect {
  op: string;
  target: string;
}

export interface ParsedShell {
  /** simple commands, words unquoted */
  commands: string[][];
  /** $(…), `…`, <(…), >(…) */
  substitution: boolean;
  /** $VAR / ${VAR} expansions in words */
  expansion: boolean;
  redirects: Redirect[];
  /** (…) subshells, { …; } groups, if/for/while/case, functions, heredocs, background & */
  complex: boolean;
  /** unbalanced quotes or parentheses */
  error: boolean;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '!', '[[', ']]', '{', '}']);

export function parseShell(script: string): ParsedShell {
  const out: ParsedShell = { commands: [], substitution: false, expansion: false, redirects: [], complex: false, error: false };
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  const s = script.replace(/\\\r?\n/g, ' ');
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) {
      if (KEYWORDS.has(words[0] as string) || /^\w+\(\)$/.test(words[0] as string)) out.complex = true;
      out.commands.push(words);
    }
    words = [];
  };
  const readUntilClose = (open: string, close: string): void => {
    // skip a balanced $( … ) / <( … ) region
    let depth = 1;
    i++;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === "'") {
        const e = s.indexOf("'", i + 1);
        i = e < 0 ? s.length : e;
      } else if (c === open) depth++;
      else if (c === close) depth--;
      i++;
    }
    if (depth > 0) out.error = true;
  };

  while (i < s.length) {
    const c = s[i] as string;
    // comments start at a word boundary
    if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '\\') {
      word += s[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) {
        out.error = true;
        word += s.slice(i + 1);
        i = s.length;
      } else {
        word += s.slice(i + 1, e);
        i = e + 1;
      }
      inWord = true;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      let closed = false;
      while (i < s.length) {
        const d = s[i] as string;
        if (d === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1] as string)) {
          word += s[i + 1];
          i += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '`') out.substitution = true;
        if (d === '$') {
          if (s[i + 1] === '(') {
            out.substitution = true;
            readUntilClose('(', ')');
            continue;
          }
          if (/[\w{@*#?$!-]/.test(s[i + 1] ?? '')) out.expansion = true;
        }
        word += d;
        i++;
      }
      if (!closed) out.error = true;
      continue;
    }
    if (c === '`') {
      out.substitution = true;
      const e = s.indexOf('`', i + 1);
      if (e < 0) out.error = true;
      i = e < 0 ? s.length : e + 1;
      inWord = true;
      continue;
    }
    if (c === '$') {
      if (s[i + 1] === '(') {
        out.substitution = true;
        readUntilClose('(', ')');
        inWord = true;
        continue;
      }
      if (s[i + 1] === "'") {
        // $'…' ANSI-C quoting: literal enough for our purposes
        i++;
        continue;
      }
      if (/[\w{@*#?$!-]/.test(s[i + 1] ?? '')) out.expansion = true;
      word += c;
      inWord = true;
      i++;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      out.substitution = true;
      i++;
      readUntilClose('(', ')');
      inWord = true;
      continue;
    }
    // redirections: [n]>, >>, <, <<, <<<, &>, >&, >|
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      let op = '';
      if (inWord && /^\d+$/.test(word)) {
        op = word;
        word = '';
        inWord = false;
      } else endWord();
      while (i < s.length && /[<>&|]/.test(s[i] as string) && !(s[i] === '|' && op.length && op !== '>' && !op.endsWith('>'))) {
        op += s[i];
        i++;
        if (op.endsWith('>|') || op.length > 3) break;
      }
      if (/<</.test(op) && !/<<</.test(op)) out.complex = true; // heredoc
      while (s[i] === ' ' || s[i] === '\t') i++;
      // target word (fd duplication like 2>&1 has a digit target)
      let target = '';
      while (i < s.length && !/[\s;&|<>()]/.test(s[i] as string)) {
        if (s[i] === '"' || s[i] === "'") {
          const q = s[i] as string;
          const e = s.indexOf(q, i + 1);
          target += s.slice(i + 1, e < 0 ? s.length : e);
          i = e < 0 ? s.length : e + 1;
          continue;
        }
        if (s[i] === '$') out.expansion = true;
        target += s[i];
        i++;
      }
      out.redirects.push({ op, target });
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '\n') {
      endCommand();
      if (c === '&' && s[i + 1] !== '&') out.complex = true; // background job
      if ((c === '|' && s[i + 1] === '|') || (c === '&' && s[i + 1] === '&') || (c === ';' && s[i + 1] === ';')) i++;
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      endCommand();
      out.complex = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return out;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

function base(word: string): string {
  return word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

/**
 * The commands a simple command really runs: wrappers such as `sudo`, `env VAR=1`, `nohup`,
 * `timeout 5`, `xargs`, `command`, `exec` are peeled off, and `bash -c '<script>'` is parsed in
 * turn. `privileged` is set when sudo/doas was involved; `opaque` when a wrapped script could not
 * be judged statically.
 */
export function effectiveCommands(words: string[], depth = 0): { commands: string[][]; privileged: boolean; opaque: boolean } {
  const res = { commands: [] as string[][], privileged: false, opaque: false };
  if (depth > 6) return { ...res, opaque: true };
  let w = [...words];
  // leading VAR=value assignments
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0] as string)) w.shift();
  for (let guard = 0; guard < 12 && w.length; guard++) {
    const cmd = base(w[0] as string);
    if (cmd === 'sudo' || cmd === 'doas') {
      res.privileged = true;
      w.shift();
      while (w.length && (w[0] as string).startsWith('-')) {
        const flag = w.shift() as string;
        if (/^-[ugCDhpRrTt]$/.test(flag)) w.shift(); // flags with a value
      }
      continue;
    }
    if (cmd === 'env') {
      w.shift();
      while (w.length && ((w[0] as string).startsWith('-') || /^[A-Za-z_]\w*=/.test(w[0] as string))) {
        const a = w.shift() as string;
        if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir' || a === '-S') w.shift();
        if (a === '--') break;
      }
      if (!w.length) return { ...res, commands: [['env']] };
      continue;
    }
    if (cmd === 'nohup' || cmd === 'command' || cmd === 'exec' || cmd === 'builtin' || cmd === 'time' || cmd === 'nice' || cmd === 'ionice' || cmd === 'stdbuf' || cmd === 'chrt' || cmd === 'setsid') {
      w.shift();
      while (w.length && (w[0] as string).startsWith('-')) {
        const a = w.shift() as string;
        if ((cmd === 'nice' && a === '-n') || (cmd === 'ionice' && /^-[cn]$/.test(a))) w.shift();
      }
      if (cmd === 'chrt' && w.length && /^\d+$/.test(w[0] as string)) w.shift();
      continue;
    }
    if (cmd === 'timeout') {
      w.shift();
      while (w.length && (w[0] as string).startsWith('-')) {
        const a = w.shift() as string;
        if (a === '-s' || a === '-k' || a === '--signal' || a === '--kill-after') w.shift();
      }
      w.shift(); // duration
      continue;
    }
    if (cmd === 'xargs') {
      w.shift();
      while (w.length && (w[0] as string).startsWith('-')) {
        const a = w.shift() as string;
        if (/^-[IdEeLnPs]$/.test(a)) w.shift();
      }
      if (!w.length) return { ...res, commands: [['echo']] }; // xargs defaults to echo
      continue;
    }
    if (SHELLS.has(cmd)) {
      const ci = w.findIndex((a, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (ci > 0 && w[ci + 1] !== undefined) {
        const inner = parseShell(w[ci + 1] as string);
        if (inner.substitution || inner.error) res.opaque = true;
        for (const c of inner.commands) {
          const sub = effectiveCommands(c, depth + 1);
          res.commands.push(...sub.commands);
          res.privileged ||= sub.privileged;
          res.opaque ||= sub.opaque;
        }
        return res;
      }
      // `bash script.sh` or an interactive shell: cannot be judged
      return { ...res, commands: [w], opaque: true };
    }
    break;
  }
  if (w.length) res.commands.push(w);
  return res;
}

/** Every command a line runs, wrappers peeled; `opaque` when any part cannot be judged statically. */
export function commandsOf(script: string): { commands: string[][]; privileged: boolean; opaque: boolean; parsed: ParsedShell } {
  const parsed = parseShell(script);
  const out = { commands: [] as string[][], privileged: false, opaque: parsed.error || parsed.substitution || parsed.complex, parsed };
  for (const c of parsed.commands) {
    const e = effectiveCommands(c);
    out.commands.push(...e.commands);
    out.privileged ||= e.privileged;
    out.opaque ||= e.opaque;
  }
  return out;
}

/** Redirections that cannot change files: to /dev/null and fd duplication (2>&1). */
export function harmlessRedirect(r: Redirect): boolean {
  if (/^\d*>&$|^\d*<&$/.test(r.op) && /^(\d+|-)$/.test(r.target)) return true;
  if (/^(\d*>>?|&>>?|\d*>\|)$/.test(r.op) && r.target === '/dev/null') return true;
  if (/^\d*<$/.test(r.op)) return true; // reading a file
  return false;
}
