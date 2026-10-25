import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseFrontmatter, stringifyFrontmatter } from '../util/frontmatter.js';
import { Bm25Index } from '../util/bm25.js';
import { runProcess } from '../util/process.js';
import { slugify } from '../util/misc.js';

export type SkillSource = 'bundled' | 'claude' | 'user' | 'project' | 'extra';

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  tags: string[];
  version?: string;
  source: SkillSource;
  dir: string;
  path: string;
  enabled: boolean;
  editable: boolean;
  files: string[];
  requires?: { toolsets?: string[]; env?: string[] };
  author?: string;
  license?: string;
}

export interface SkillDirs {
  bundled?: string;
  user: string;
  project?: string;
  extra?: string[];
  claudeCompat?: boolean;
  cwd?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A saved copy of a skill taken before it was changed or deleted. */
export interface SkillRevision {
  version: string;
  savedAt: number;
  reason: string;
  dir: string;
}

/** Why a proposed skill (or change) was not admitted. Empty = admitted. */
export interface AdmissionResult {
  ok: boolean;
  problems: string[];
}

const MAX_BODY = 24_000;
const SECRET_RE = /(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// values that only make sense for the task at hand: a skill holding them has learned the
// instance, not the procedure (the harness equivalent of overfitting to a benchmark)
const SPECIFIC_RE: [RegExp, string][] = [
  [/(^|[\s"'`(])\/(tmp|private\/var\/folders|var\/folders)\/[\w.-]+/m, 'a temporary directory path'],
  [/\b[sr]_[a-z0-9]{10,}\b|\bsession [0-9a-f-]{16,}\b/i, 'a session or run id'],
  [/\b[0-9a-f]{32,}\b/i, 'a long hash or token-like value'],
  [/\bkronos-[a-z]+-[A-Za-z0-9]{6}\b/, 'a throwaway workspace name'],
];

const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function listFiles(dir: string, base = dir, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || out.length > 200) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out, depth + 1);
    else if (e.name !== 'SKILL.md') out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Skills = procedural memory. Compatible with the open SKILL.md standard
 * (agentskills.io / Anthropic Agent Skills / Claude Code skills / Hermes skills).
 * Layout: <root>/<skill>/SKILL.md or <root>/<category>/<skill>/SKILL.md.
 */
export class SkillRegistry {
  private skills = new Map<string, SkillInfo>();
  private disabled = new Set<string>();

  constructor(private dirs: SkillDirs, disabled: string[] = []) {
    this.disabled = new Set(disabled);
    this.reload();
  }

  configure(dirs: SkillDirs, disabled: string[]): void {
    this.dirs = dirs;
    this.disabled = new Set(disabled);
    this.reload();
  }

  /** <user skills>/.history — skipped by discovery because it starts with a dot */
  private get historyRoot(): string {
    return join(this.dirs.user, '.history');
  }

  /**
   * Admission gate for skills the agent writes. A skill library that only grows becomes noise,
   * and edits tuned to one task hurt the next, so a new skill or a change is admitted only if it
   * is reusable: bounded size, a description that says when to use it, no secrets, no values
   * tied to one task, not a near-duplicate of an existing skill, and not a change that was
   * already tried and rolled back.
   */
  admit(input: { name: string; description?: string; body?: string; existing?: string }): AdmissionResult {
    const candidate = { ...input, name: slugify(input.name, 64) };
    const problems: string[] = [];
    const text = `${candidate.description ?? ''}\n${candidate.body ?? ''}`;
    if ((candidate.body ?? '').length > MAX_BODY) problems.push(`the body is ${candidate.body!.length.toLocaleString()} chars; keep SKILL.md under ${MAX_BODY.toLocaleString()} and move long material into resource files`);
    if (candidate.description !== undefined && candidate.description.trim().length < 20) problems.push('the description must say what the skill does and when to use it (at least a sentence)');
    if (SECRET_RE.test(text)) problems.push('it contains what looks like a secret (API key, token or private key) — never store credentials in skills');
    for (const [re, what] of SPECIFIC_RE) if (re.test(text)) problems.push(`it contains ${what}; replace task-specific values with placeholders or parameters so the skill is reusable`);
    if (!candidate.existing && candidate.description) {
      const flat = (n: string) => n.replace(/[-_.]/g, '');
      // an editable skill of the same name, or one that reads the same, is a duplicate;
      // shadowing a bundled skill with a user copy of the same name stays allowed
      const twin = this.list({ includeDisabled: true }).find((s) =>
        s.name === candidate.name ? s.editable : flat(s.name) === flat(candidate.name) || jaccard(s.description, candidate.description!) >= 0.6,
      );
      if (twin) problems.push(`it duplicates the existing skill "${twin.name}" (${twin.description.slice(0, 120)}) — patch that skill instead of creating a new one`);
    }
    if (candidate.existing !== undefined && candidate.body !== undefined && this.wasRolledBack(candidate.name, candidate.body)) {
      problems.push('this exact change was tried before and rolled back; propose a different fix');
    }
    return { ok: problems.length === 0, problems };
  }

  /** Earlier versions of a skill, newest first. */
  history(name: string): SkillRevision[] {
    const dir = join(this.historyRoot, slugify(name, 64));
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        let meta: { version?: string; savedAt?: number; reason?: string } = {};
        try {
          meta = JSON.parse(readFileSync(join(dir, e.name, '.revision.json'), 'utf8'));
        } catch {
          /* legacy */
        }
        return { version: meta.version ?? '?', savedAt: meta.savedAt ?? statSync(join(dir, e.name)).mtimeMs, reason: meta.reason ?? '', dir: join(dir, e.name) };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Copy the current state of an editable skill into its history before it changes. */
  private snapshot(info: SkillInfo, reason: string): void {
    const savedAt = Date.now();
    const dest = join(this.historyRoot, info.name, `${info.version ?? '1.0.0'}-${savedAt}`);
    mkdirSync(dest, { recursive: true });
    cpSync(info.dir, dest, { recursive: true, filter: (p) => !p.split(sep).includes('.history') });
    writeFileSync(join(dest, '.revision.json'), JSON.stringify({ version: info.version ?? '1.0.0', savedAt, reason }));
    // keep the 20 newest revisions per skill
    for (const old of this.history(info.name).slice(20)) rmSync(old.dir, { recursive: true, force: true });
  }

  private logEdit(entry: Record<string, unknown>): void {
    try {
      mkdirSync(this.historyRoot, { recursive: true });
      appendFileSync(join(this.historyRoot, 'edits.jsonl'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch {
      /* history is best effort */
    }
  }

  private edits(): { at: number; name: string; action: string; hash?: string; reverted?: boolean }[] {
    const file = join(this.historyRoot, 'edits.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  private wasRolledBack(name: string, body: string): boolean {
    const h = hash(body.trim());
    return this.edits().some((e) => e.name === name && e.action === 'rollback' && (e as { undid?: string[] }).undid?.includes(h));
  }

  /**
   * Restore an earlier version (the latest saved one by default). The current state is saved
   * first, so a rollback can itself be undone, and the reverted content is remembered so the
   * same change is not proposed again.
   */
  rollback(name: string, version?: string): SkillInfo {
    const info = this.get(name);
    if (info && !info.editable) throw new Error(`"${name}" is a ${info.source} skill and has no editable history`);
    const key = info?.name ?? slugify(name, 64);
    const revisions = this.history(key);
    const target = version ? revisions.find((r) => r.version === version) : revisions[0];
    if (!target) throw new Error(revisions.length ? `no saved version ${version} of "${name}"; versions: ${revisions.map((r) => r.version).join(', ')}` : `"${name}" has no earlier versions`);
    const undid: string[] = [];
    let dest: string;
    if (info) {
      undid.push(hash(parseFrontmatter(readFileSync(info.path, 'utf8')).body.trim()));
      this.snapshot(info, `before rollback to ${target.version}`);
      rmSync(info.dir, { recursive: true, force: true });
      dest = info.dir;
    } else {
      // restoring a deleted skill
      const { data } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(target.dir, 'SKILL.md'), 'utf8'));
      dest = join(this.dirs.user, data.category ? slugify(String(data.category), 32) : '', key);
    }
    cpSync(target.dir, dest, { recursive: true, filter: (p) => !p.endsWith('.revision.json') });
    this.logEdit({ name: key, action: 'rollback', to: target.version, undid });
    this.reload();
    const restored = this.get(key);
    if (!restored) throw new Error(`restored ${key} but it could not be loaded`);
    return restored;
  }

  /** The SKILL.md body a patch would produce, without writing it (for admission checks). */
  previewPatch(name: string, oldText: string, newText: string): string {
    const info = this.get(name);
    if (!info) throw new Error(`Skill "${name}" not found`);
    const src = readFileSync(info.path, 'utf8');
    const count = src.split(oldText).length - 1;
    if (count !== 1) throw new Error(count ? `old_text occurs ${count} times; include more context` : 'old_text not found in SKILL.md');
    return parseFrontmatter(src.replace(oldText, newText)).body;
  }

  private roots(): { dir: string; source: SkillSource }[] {
    const r: { dir: string; source: SkillSource }[] = [];
    if (this.dirs.bundled) r.push({ dir: this.dirs.bundled, source: 'bundled' });
    if (this.dirs.claudeCompat) {
      r.push({ dir: join(homedir(), '.claude', 'skills'), source: 'claude' });
      if (this.dirs.cwd) r.push({ dir: join(this.dirs.cwd, '.claude', 'skills'), source: 'claude' });
    }
    for (const d of this.dirs.extra ?? []) r.push({ dir: d, source: 'extra' });
    r.push({ dir: this.dirs.user, source: 'user' });
    if (this.dirs.project) r.push({ dir: this.dirs.project, source: 'project' });
    return r.filter((x) => existsSync(x.dir));
  }

  reload(): void {
    this.skills.clear();
    for (const { dir, source } of this.roots()) {
      for (const skillFile of this.findSkillFiles(dir)) {
        const info = this.load(skillFile, dir, source);
        if (info) this.skills.set(info.name, info); // later roots override earlier ones
      }
    }
  }

  private findSkillFiles(root: string): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
        out.push(join(dir, 'SKILL.md'));
        return;
      }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(join(dir, e.name), depth + 1);
    };
    visit(root, 0);
    return out;
  }

  private load(file: string, root: string, source: SkillSource): SkillInfo | null {
    try {
      const { data } = parseFrontmatter<Record<string, unknown>>(readFileSync(file, 'utf8'));
      const dir = dirname(file);
      const name = String(data.name ?? basename(dir)).trim();
      if (!name) return null;
      const rel = relative(root, dir).split(sep);
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      const category = String(data.category ?? metadata.category ?? (rel.length > 1 ? rel[0] : 'general'));
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : Array.isArray(metadata.tags) ? (metadata.tags as unknown[]).map(String) : [];
      return {
        name,
        description: String(data.description ?? '').trim(),
        category: category.toLowerCase(),
        tags,
        version: data.version ? String(data.version) : metadata.version ? String(metadata.version) : undefined,
        source,
        dir,
        path: file,
        enabled: !this.disabled.has(name),
        editable: source === 'user' || source === 'project',
        files: listFiles(dir),
        requires: (data.requires as SkillInfo['requires']) ?? undefined,
        author: data.author ? String(data.author) : undefined,
        license: data.license ? String(data.license) : undefined,
      };
    } catch {
      return null;
    }
  }

  list(opts: { includeDisabled?: boolean } = {}): SkillInfo[] {
    return [...this.skills.values()]
      .filter((s) => opts.includeDisabled || s.enabled)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name) ?? [...this.skills.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  categories(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.skills.values()) out[s.category] = (out[s.category] ?? 0) + 1;
    return out;
  }

  /** Read SKILL.md body (or a bundled resource file) for progressive disclosure. */
  read(name: string, file?: string): { info: SkillInfo; content: string } {
    const info = this.get(name);
    if (!info) throw new Error(`Skill "${name}" not found. Use skills_list to see available skills.`);
    if (!file) {
      const { body } = parseFrontmatter(readFileSync(info.path, 'utf8'));
      const extra = info.files.length ? `\n\n---\nFiles in this skill (read with skill_view name=${info.name} file=<path>):\n${info.files.map((f) => `- ${f}`).join('\n')}` : '';
      return { info, content: `${body.trim()}${extra}\n\n(skill directory: ${info.dir})` };
    }
    const target = resolve(info.dir, file);
    if (!target.startsWith(info.dir + sep)) throw new Error('file must be inside the skill directory');
    if (!existsSync(target)) throw new Error(`"${file}" does not exist in skill ${name}. Files: ${info.files.join(', ')}`);
    return { info, content: readFileSync(target, 'utf8') };
  }

  search(query: string, limit = 8): SkillInfo[] {
    const idx = new Bm25Index(this.list().map((s) => ({ id: s.name, text: `${s.name} ${s.name} ${s.description} ${s.tags.join(' ')} ${s.category}`, data: s })));
    return idx.search(query, limit).map((h) => h.data);
  }

  /** Compact index injected into the system prompt (names + descriptions, grouped). */
  promptIndex(maxChars = 9000): string {
    const groups = new Map<string, SkillInfo[]>();
    for (const s of this.list()) {
      const g = groups.get(s.category) ?? [];
      g.push(s);
      groups.set(s.category, g);
    }
    const lines: string[] = [];
    for (const [cat, list] of groups) {
      lines.push(`[${cat}]`);
      for (const s of list) lines.push(`- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    let out = lines.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n… (more skills available — use skills_list)`;
    return out;
  }

  create(input: { name: string; description: string; body: string; category?: string; tags?: string[]; files?: Record<string, string> }): SkillInfo {
    const name = slugify(input.name, 64);
    if (!NAME_RE.test(name)) throw new Error(`invalid skill name "${input.name}"`);
    if (this.skills.get(name)?.editable === false) {
      // shadow a bundled skill with an editable user copy
    } else if (this.skills.has(name)) throw new Error(`skill "${name}" already exists — use action "update" or "patch"`);
    const dir = join(this.dirs.user, input.category ? slugify(input.category, 32) : '', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      stringifyFrontmatter(
        { name, description: input.description.trim(), category: input.category, tags: input.tags?.length ? input.tags : undefined, version: '1.0.0', author: 'kronos' },
        input.body,
      ),
    );
    for (const [rel, content] of Object.entries(input.files ?? {})) this.writeResource(dir, rel, content);
    this.logEdit({ name, action: 'create', hash: hash(input.body.trim()) });
    this.reload();
    return this.get(name) as SkillInfo;
  }

  private writeResource(dir: string, rel: string, content: string): void {
    const target = resolve(dir, rel);
    if (!target.startsWith(dir + sep)) throw new Error('resource path escapes the skill directory');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  /** Make a skill editable (copy bundled/claude skills into the user dir first). */
  private editableCopy(name: string): SkillInfo {
    const info = this.get(name);
    if (!info) throw new Error(`Skill "${name}" not found`);
    if (info.editable) return info;
    const dest = join(this.dirs.user, info.category, info.name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(info.dir, dest, { recursive: true });
    this.reload();
    return this.get(name) as SkillInfo;
  }

  update(name: string, patch: { description?: string; body?: string; files?: Record<string, string>; bumpVersion?: boolean }): SkillInfo {
    const info = this.editableCopy(name);
    this.snapshot(info, 'update');
    const { data, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(info.path, 'utf8'));
    this.logEdit({ name: info.name, action: 'update', hash: hash((patch.body ?? body).trim()) });
    if (patch.description) data.description = patch.description;
    if (patch.bumpVersion !== false) data.version = bump(String(data.version ?? '1.0.0'));
    writeFileSync(info.path, stringifyFrontmatter(data, patch.body ?? body));
    for (const [rel, content] of Object.entries(patch.files ?? {})) this.writeResource(info.dir, rel, content);
    this.reload();
    return this.get(name) as SkillInfo;
  }

  /** Replace a unique span inside SKILL.md (self-improvement while using a skill). */
  patch(name: string, oldText: string, newText: string): SkillInfo {
    const info = this.editableCopy(name);
    const src = readFileSync(info.path, 'utf8');
    const count = src.split(oldText).length - 1;
    if (count === 0) throw new Error('old_text not found in SKILL.md');
    if (count > 1) throw new Error(`old_text occurs ${count} times; include more context`);
    const { data, body } = parseFrontmatter<Record<string, unknown>>(src.replace(oldText, newText));
    this.snapshot(info, 'patch');
    this.logEdit({ name: info.name, action: 'patch', hash: hash(body.trim()) });
    data.version = bump(String(data.version ?? '1.0.0'));
    writeFileSync(info.path, stringifyFrontmatter(data, body));
    this.reload();
    return this.get(name) as SkillInfo;
  }

  delete(name: string): void {
    const info = this.get(name);
    if (!info) throw new Error(`Skill "${name}" not found`);
    if (!info.editable) throw new Error(`"${name}" is a ${info.source} skill; disable it instead of deleting`);
    this.snapshot(info, 'delete');
    this.logEdit({ name: info.name, action: 'delete' });
    rmSync(info.dir, { recursive: true, force: true });
    this.reload();
  }

  setEnabled(name: string, enabled: boolean): string[] {
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
    const s = this.skills.get(name);
    if (s) s.enabled = enabled;
    return [...this.disabled];
  }

  /**
   * Install skills from a git URL, "owner/repo[/sub/path]" GitHub shorthand, or local path.
   * Every SKILL.md found is copied into the user skills directory.
   */
  async install(sourceSpec: string, opts: { category?: string } = {}): Promise<SkillInfo[]> {
    let root = sourceSpec;
    let cleanup: string | undefined;
    if (!existsSync(sourceSpec)) {
      let url = sourceSpec;
      let sub = '';
      const gh = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(sourceSpec);
      if (gh && !sourceSpec.includes(':')) {
        url = `https://github.com/${gh[1]}/${gh[2]}.git`;
        sub = gh[3] ?? '';
      }
      const tmp = join(tmpdir(), `kronos-skill-${Date.now()}`);
      const r = await runProcess('git', ['clone', '--depth', '1', url, tmp], { timeoutMs: 120_000 });
      if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr.trim() || r.output.trim()}`);
      cleanup = tmp;
      root = sub ? join(tmp, sub) : tmp;
    }
    try {
      const files = statSync(root).isFile() ? [root] : this.findSkillFiles(root);
      if (!files.length) throw new Error('no SKILL.md found at that source');
      const installed: string[] = [];
      for (const f of files) {
        const src = dirname(f);
        const { data } = parseFrontmatter<Record<string, unknown>>(readFileSync(f, 'utf8'));
        const name = slugify(String(data.name ?? basename(src)), 64);
        const dest = join(this.dirs.user, opts.category ? slugify(opts.category, 32) : 'installed', name);
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { recursive: true, filter: (p) => !p.includes(`${sep}.git`) });
        installed.push(name);
      }
      this.reload();
      return installed.map((n) => this.get(n)).filter((s): s is SkillInfo => Boolean(s));
    } finally {
      if (cleanup) rmSync(cleanup, { recursive: true, force: true });
    }
  }
}

function bump(v: string): string {
  const parts = v.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '1.0.1';
  return `${parts[0]}.${parts[1]}.${(parts[2] as number) + 1}`;
}
