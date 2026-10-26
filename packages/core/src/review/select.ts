import { basename, extname } from 'node:path';
import { matchGlob } from '../util/glob.js';
import type { DiffFile } from './diff.js';

export interface SelectOptions {
  /** only review paths matching one of these globs (empty: everything) */
  include?: string[];
  /** never review paths matching these globs */
  exclude?: string[];
  /** files with more changed lines than this are listed but not reviewed line by line */
  maxFileLines?: number;
}

export interface Skipped {
  path: string;
  reason: string;
}

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
  'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'packages.lock.json', 'flake.lock', 'gradle.lockfile',
]);

/** Generated, vendored or bundled output: changes there are not written by people. */
const GENERATED = [
  '**/node_modules/**', '**/vendor/**', '**/third_party/**', '**/dist/**', '**/build/**', '**/out/**', '**/target/**', '**/.next/**', '**/coverage/**',
  '**/__snapshots__/**', '**/*.snap', '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.pb.go', '**/*_pb2.py', '**/*.pb.ts', '**/*.generated.*', '**/*.g.dart',
  '**/*.designer.cs', '**/generated/**', '**/__generated__/**',
];

/** Secrets never leave the machine for a model, even for review. */
const SECRET = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/*.keystore', '**/credentials.json', '**/secrets.*'];

const DATA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.jar', '.so', '.dll', '.exe', '.bin', '.svg', '.csv', '.tsv', '.parquet', '.lock']);

function anyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(path, g) || matchGlob(path, `**/${g}`));
}

/**
 * Deterministic choice of what the model reviews. Nothing here costs a token: binary, data,
 * lock, generated and secret files are set aside with the reason, as are oversized files.
 */
export function selectFiles(files: DiffFile[], opts: SelectOptions = {}): { selected: DiffFile[]; skipped: Skipped[] } {
  const selected: DiffFile[] = [];
  const skipped: Skipped[] = [];
  const maxLines = opts.maxFileLines ?? 3000;
  for (const f of files) {
    const p = f.path;
    const reason =
      f.binary ? 'binary file'
      : f.status === 'deleted' ? 'deleted'
      : !f.hunks.length ? (f.status === 'renamed' ? 'renamed without changes' : 'no textual changes')
      : opts.include?.length && !anyGlob(p, opts.include) ? 'not in review.include'
      : opts.exclude?.length && anyGlob(p, opts.exclude) ? 'excluded by configuration'
      : anyGlob(p, SECRET) ? 'may contain secrets'
      : LOCKFILES.has(basename(p)) ? 'lock file'
      : anyGlob(p, GENERATED) ? 'generated or vendored'
      : DATA_EXT.has(extname(p).toLowerCase()) ? 'data or asset file'
      : f.additions + f.deletions > maxLines ? `too large (${f.additions + f.deletions} changed lines; limit ${maxLines})`
      : '';
    if (reason) skipped.push({ path: p, reason });
    else selected.push(f);
  }
  return { selected, skipped };
}

export interface ReviewGroup {
  id: number;
  files: DiffFile[];
  changedLines: number;
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|^test_.*\.py$/i;

function stem(path: string): string {
  return basename(path)
    .replace(/\.(test|spec)(?=\.)/i, '')
    .replace(/_test(?=\.go$)/, '')
    .replace(/^test_/, '')
    .replace(/\.[^.]+$/, '');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Split the selected files into review groups of related files. Each group gets its own reviewer,
 * so a group stays small enough to be read with care: at most `maxFiles` files and about
 * `maxLines` changed lines. Tests travel with the code they test; otherwise files of the same
 * directory stay together. Fully deterministic (no model call), so a re-run reviews the same groups.
 */
export function groupFiles(files: DiffFile[], opts: { maxFiles?: number; maxLines?: number } = {}): ReviewGroup[] {
  const maxFiles = Math.max(1, opts.maxFiles ?? 8);
  const maxLines = Math.max(50, opts.maxLines ?? 1500);
  const size = (f: DiffFile) => f.additions + f.deletions;
  // clusters: a source file and its tests
  const sources = files.filter((f) => !TEST_RE.test(f.path));
  const tests = files.filter((f) => TEST_RE.test(f.path));
  const clusters: DiffFile[][] = sources.map((f) => [f]);
  for (const t of tests) {
    const home = clusters.find((c) => stem(c[0]!.path) === stem(t.path));
    if (home && home.length < maxFiles) home.push(t);
    else clusters.push([t]);
  }
  clusters.sort((a, b) => dirOf(a[0]!.path).localeCompare(dirOf(b[0]!.path)) || a[0]!.path.localeCompare(b[0]!.path));
  const groups: ReviewGroup[] = [];
  let cur: DiffFile[] = [];
  let lines = 0;
  const flush = () => {
    if (cur.length) groups.push({ id: groups.length + 1, files: cur, changedLines: lines });
    cur = [];
    lines = 0;
  };
  for (const c of clusters) {
    const n = c.reduce((s, f) => s + size(f), 0);
    const sameArea = cur.length > 0 && dirOf(cur[0]!.path).split('/').slice(0, 2).join('/') === dirOf(c[0]!.path).split('/').slice(0, 2).join('/');
    if (cur.length && (cur.length + c.length > maxFiles || lines + n > maxLines || (!sameArea && lines + n > maxLines / 2))) flush();
    cur.push(...c);
    lines += n;
  }
  flush();
  return groups;
}
