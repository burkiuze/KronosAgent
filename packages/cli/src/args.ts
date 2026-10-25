export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
  /** everything after a literal `--` */
  rest: string[];
}

const SHORT: Record<string, string> = {
  m: 'model',
  p: 'profile',
  s: 'session',
  c: 'continue',
  v: 'verbose',
  h: 'help',
  y: 'yolo',
  C: 'cwd',
  j: 'json',
  q: 'quiet',
};

/** Small argv parser: positionals, --flag, --flag=value, --flag value, -x value, --no-flag, `--` passthrough. */
export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {}, rest: [] };
  const bools = new Set(['help', 'version', 'verbose', 'json', 'yolo', 'plan', 'continue', 'quiet', 'open', 'no-open', 'stream', 'hidden', 'user', 'force', ...booleanFlags]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (name.startsWith('no-') && !bools.has(name)) {
        out.flags[name.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (!bools.has(name) && next !== undefined && !next.startsWith('-')) {
        out.flags[name] = next;
        i += 1;
      } else out.flags[name] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const key = SHORT[a.slice(1)] ?? a.slice(1);
      const next = argv[i + 1];
      if (!bools.has(key) && next !== undefined && !next.startsWith('-')) {
        out.flags[key] = next;
        i += 1;
      } else out.flags[key] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}
