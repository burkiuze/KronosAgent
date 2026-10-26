import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kronos } from '../runtime.js';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentDefinition } from '../agent/definitions.js';
import { addUsage, emptyUsage, type Part, type TextPart, type Usage } from '../types.js';
import { repairJson } from '../providers/toolcalls.js';
import { runProcess } from '../util/process.js';
import { errorMessage, mapLimit, newId } from '../util/misc.js';
import { truncate } from '../util/text.js';
import { logger } from '../util/log.js';
import { collectDiff, renderFileDiff, type DiffFile, type DiffSpec } from './diff.js';
import { groupFiles, selectFiles, type ReviewGroup, type Skipped } from './select.js';
import { checklistsFor, GENERAL_CHECKS, loadProjectRules, rulesFor, type ProjectRule } from './rules.js';
import {
  dedupeFindings,
  locateFinding,
  newSideLines,
  normalizeCategory,
  normalizeSeverity,
  resolveFindingPath,
  severityRank,
  sortFindings,
  type FileView,
  type Finding,
  type Severity,
} from './findings.js';

const log = logger('review');

export interface ReviewOptions {
  cwd: string;
  spec: DiffSpec;
  model?: string;
  /** extra instructions: what to focus on, what the change is meant to do */
  focus?: string;
  verify?: boolean;
  minSeverity?: Severity;
  /** chat the review belongs to (reviewer sessions are filed under it) */
  parentSessionId?: string;
  signal?: AbortSignal;
  onProgress?: (p: ReviewProgress) => void;
}

export type ReviewProgress =
  | { stage: 'diff'; files: number; selected: number; groups: number; label: string }
  | { stage: 'group'; group: number; groups: number; status: 'start' | 'done' | 'error'; files: string[]; findings?: number; detail?: string }
  | { stage: 'activity'; group: number; detail: string }
  | { stage: 'verify'; candidates: number }
  | { stage: 'done'; findings: number; dropped: number };

export interface DroppedFinding {
  finding: Finding;
  reason: string;
}

export interface ReviewResult {
  label: string;
  headSha?: string;
  reviewed: string[];
  skipped: Skipped[];
  groups: number;
  findings: Finding[];
  /** findings removed by locating, verification or thresholds, with the reason */
  dropped: DroppedFinding[];
  verdict: 'correct' | 'incorrect';
  summary: string;
  /** per-group notes written by the reviewers */
  notes: string[];
  errors: string[];
  usage: Usage;
  durationMs: number;
  model: string;
  sessionId?: string;
}

const REVIEWER: AgentDefinition = {
  name: 'code-reviewer',
  description: 'Reviews one group of changed files and reports verified, actionable findings.',
  source: 'builtin',
  prompt: [
    'You are an exacting senior code reviewer. Another engineer made the change below; find the problems they would want to fix before merging.',
    '',
    'What counts as a finding:',
    '1. It meaningfully affects correctness, security, reliability, performance or maintainability.',
    '2. It is discrete and actionable — one problem, one place, one fix.',
    '3. It was introduced or exposed by this change (do not flag pre-existing problems in untouched code).',
    '4. You can name the concrete input, state or caller that triggers it. "This might break something elsewhere" is not enough: open the other code and show it.',
    '5. It is not an intentional change by the author, and does not depend on guesses about their intent.',
    '6. The author would fix it if told. Ignore formatting, naming taste and trivial style unless a project rule requires it.',
    '',
    'How to work:',
    '- Read every changed file in your group. The diff shows new-side line numbers; read surrounding code, callers and definitions with read_file/grep before judging.',
    '- For each finding call review_comment immediately, with `existing_code` copied exactly from the new version of the file (1-5 lines) — it is used to place the comment.',
    '- Body: one short paragraph — what goes wrong, when (the triggering input or scenario), and the fix. Matter-of-fact, no praise, no code longer than 3 lines.',
    '- `suggestion`: only when you are sure of the exact replacement for lines start_line..end_line, keeping their indentation.',
    '- Severity: critical = data loss, security hole or crash on common paths; high = wrong behavior users will hit; medium = edge-case bugs and risky patterns; low = minor issues.',
    '- Several issues in one place: one comment per distinct issue. No duplicates.',
    '- Finally call review_done with every file you reviewed, your verdict and a 1-3 sentence summary. If there is nothing worth flagging, call review_done with no comments — that is a good outcome.',
    '- Never modify files. Never invent code you have not read.',
  ].join('\n'),
};

const REFUTER_SYSTEM = [
  'You are the fact-checker of a code review. Each candidate finding below came from a reviewer; your job is to try to prove it wrong using the code shown.',
  'Drop a finding only on one of these grounds, and say which:',
  'A — the code it describes is not in the shown file (wrong code, misread or invented);',
  'B — a shown line already prevents the problem (quote that line);',
  'C — it is about code this change did not touch and the change does not affect;',
  'D — it is purely a matter of taste (style, naming, formatting) with no rule and no effect on behavior.',
  'Findings about security, memory safety, concurrency, compatibility/behavior changes or resource leaks may only be dropped on ground A or B.',
  'When unsure, keep it. You may lower (never raise) the severity when the finding overstates it.',
  'Answer with JSON only: {"results": [{"id": "F1", "verdict": "keep" | "drop", "ground": "A" | "B" | "C" | "D" | null, "severity": "critical" | "high" | "medium" | "low" | null, "reason": "<one sentence>"}]}',
].join('\n');

const PROTECTED = new Set(['security', 'concurrency', 'compatibility', 'reliability']);

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Raw finding as a model wrote it (tool call or JSON fallback), in any of the common shapes. */
function toFinding(raw: Record<string, unknown>, group: number): Finding | undefined {
  const loc = (raw.code_location ?? raw.location ?? {}) as Record<string, unknown>;
  const range = (loc.line_range ?? {}) as Record<string, unknown>;
  const path = String(raw.path ?? raw.file ?? loc.absolute_file_path ?? loc.path ?? '').trim();
  const title = String(raw.title ?? '').replace(/^\[P\d\]\s*/, '').trim();
  const body = String(raw.body ?? raw.content ?? raw.message ?? raw.description ?? '').trim();
  if (!path || (!title && !body)) return undefined;
  const start = Number(raw.start_line ?? raw.line ?? range.start ?? raw.startLine ?? 0) || 0;
  const end = Number(raw.end_line ?? range.end ?? raw.endLine ?? start) || start;
  const prio = /^\[P(\d)\]/.exec(String(raw.title ?? ''))?.[1];
  let confidence = Number(raw.confidence ?? raw.confidence_score ?? 0.7);
  if (!Number.isFinite(confidence)) confidence = 0.7;
  if (confidence > 1) confidence = confidence / 100;
  return {
    id: '',
    path,
    startLine: start,
    endLine: Math.max(start, end),
    title: title || truncate(body.split(/(?<=[.!?])\s/)[0] ?? body, 80),
    body,
    severity: normalizeSeverity(raw.severity ?? raw.priority ?? (prio !== undefined ? `p${prio}` : undefined)),
    category: normalizeCategory(raw.category ?? raw.type),
    confidence: Math.max(0, Math.min(1, confidence)),
    suggestion: typeof raw.suggestion === 'string' && raw.suggestion.trim() ? String(raw.suggestion).replace(/^```[a-z]*\n|\n?```$/g, '') : typeof raw.suggestion_code === 'string' && raw.suggestion_code ? String(raw.suggestion_code) : undefined,
    existingCode: typeof raw.existing_code === 'string' ? raw.existing_code : typeof raw.code === 'string' ? raw.code : undefined,
    rule: typeof raw.rule === 'string' && raw.rule.trim() ? raw.rule.trim() : undefined,
    group,
    located: 'line',
    inDiff: false,
  };
}

/** Findings a model wrote as JSON in plain text (no tool support, or it ignored the tools). */
export function findingsFromText(text: string, group: number): Finding[] {
  const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) return [];
  const data = repairJson(m[0]) as unknown;
  const list = Array.isArray(data) ? data : Array.isArray((data as { findings?: unknown })?.findings) ? (data as { findings: unknown[] }).findings : [];
  return list.flatMap((r) => (r && typeof r === 'object' ? [toFinding(r as Record<string, unknown>, group)].filter((f): f is Finding => !!f) : []));
}

interface GroupOutcome {
  findings: Finding[];
  verdict?: 'correct' | 'incorrect';
  summary?: string;
  usage: Usage;
  error?: string;
}

export class ReviewEngine {
  constructor(private rt: Kronos) {}

  private get cfg() {
    return this.rt.config.review;
  }

  /** New-side content of a changed file, from the source the diff describes. */
  private async content(cwd: string, spec: DiffSpec, path: string, headSha?: string): Promise<string[] | undefined> {
    const disk = () => {
      const p = join(cwd, path);
      if (!existsSync(p) || statSync(p).size > 4 * 1024 * 1024) return undefined;
      return readFileSync(p, 'utf8').split('\n');
    };
    if (spec.kind === 'workspace' || spec.kind === 'raw') return disk();
    const rev = spec.kind === 'staged' ? '' : (headSha ?? 'HEAD');
    const r = await runProcess('git', ['show', `${rev}:${path}`], { cwd, timeoutMs: 20_000, maxBuffer: 8 * 1024 * 1024 });
    return r.exitCode === 0 ? r.stdout.split('\n') : disk();
  }

  async run(opts: ReviewOptions): Promise<ReviewResult> {
    const started = Date.now();
    const progress = (p: ReviewProgress) => {
      try {
        opts.onProgress?.(p);
      } catch {
        /* a broken listener never stops the review */
      }
    };
    const diff = await collectDiff(opts.cwd, opts.spec, opts.signal);
    const { selected, skipped } = selectFiles(diff.files, { include: this.cfg.include, exclude: this.cfg.exclude, maxFileLines: this.cfg.maxFileLines });
    const groups = groupFiles(selected, { maxFiles: this.cfg.maxFilesPerGroup, maxLines: this.cfg.maxGroupLines });
    progress({ stage: 'diff', files: diff.files.length, selected: selected.length, groups: groups.length, label: diff.label });
    const modelRef = this.rt.providers.resolve(opts.model ?? this.cfg.model ?? undefined).ref;
    const base: ReviewResult = {
      label: diff.label,
      headSha: diff.headSha,
      reviewed: selected.map((f) => f.path),
      skipped,
      groups: groups.length,
      findings: [],
      dropped: [],
      verdict: 'correct',
      summary: '',
      notes: [],
      errors: [],
      usage: emptyUsage(),
      durationMs: 0,
      model: modelRef,
    };
    if (!selected.length) {
      base.summary = diff.files.length ? 'Nothing to review: every changed file was set aside (see skipped).' : `No changes found (${diff.label}).`;
      base.durationMs = Date.now() - started;
      progress({ stage: 'done', findings: 0, dropped: 0 });
      return base;
    }

    const views = new Map<string, FileView>();
    for (const f of diff.files) if (!f.binary && f.status !== 'deleted') views.set(f.path, { diff: f, lines: await this.content(opts.cwd, opts.spec, f.path, diff.headSha) });
    const rules = loadProjectRules(opts.cwd);
    const parent =
      opts.parentSessionId ??
      this.rt.sessions.create({ title: `Code review: ${diff.label}`, cwd: opts.cwd, source: 'review', model: modelRef, archived: true }).id;
    base.sessionId = parent;

    const outcomes = await mapLimit(groups, Math.max(1, this.cfg.concurrency), async (g) => {
      if (opts.signal?.aborted) return { findings: [], usage: emptyUsage(), error: 'interrupted' } as GroupOutcome;
      progress({ stage: 'group', group: g.id, groups: groups.length, status: 'start', files: g.files.map((f) => f.path) });
      const out = await this.reviewGroup(g, groups.length, selected, rules, views, { ...opts, model: modelRef }, parent, progress).catch(
        (e): GroupOutcome => ({ findings: [], usage: emptyUsage(), error: errorMessage(e) }),
      );
      progress({ stage: 'group', group: g.id, groups: groups.length, status: out.error ? 'error' : 'done', files: g.files.map((f) => f.path), findings: out.findings.length, detail: out.error });
      return out;
    });

    let candidates: Finding[] = [];
    for (const [i, o] of outcomes.entries()) {
      base.usage = addUsage(base.usage, o.usage);
      if (o.error) base.errors.push(`group ${i + 1}: ${o.error}`);
      if (o.summary) base.notes.push(o.summary);
      for (const f of o.findings) {
        const placed = locateFinding(f, views);
        if (!placed) base.dropped.push({ finding: f, reason: `${f.path} is not part of this change` });
        else candidates.push(placed);
      }
    }
    candidates = dedupeFindings(candidates).map((f, i) => ({ ...f, id: `F${i + 1}` }));

    if (opts.verify ?? this.cfg.verify) {
      progress({ stage: 'verify', candidates: candidates.length });
      candidates = await this.verify(candidates, views, opts, base);
    }

    const minSev = severityRank(opts.minSeverity ?? this.cfg.minSeverity);
    const findings: Finding[] = [];
    for (const f of candidates) {
      if (severityRank(f.severity) > minSev) base.dropped.push({ finding: f, reason: `below the ${opts.minSeverity ?? this.cfg.minSeverity} threshold` });
      else if (f.confidence < this.cfg.minConfidence && f.verification?.verdict !== 'confirmed') base.dropped.push({ finding: f, reason: `low confidence (${f.confidence})` });
      else findings.push(f);
    }
    base.findings = sortFindings(findings).map((f, i) => ({ ...f, id: `F${i + 1}` }));
    const blocking = base.findings.some((f) => severityRank(f.severity) <= 1 && f.category !== 'style' && f.category !== 'documentation');
    base.verdict = blocking || outcomes.some((o) => o.verdict === 'incorrect' && o.findings.some((f) => severityRank(f.severity) <= 2)) ? 'incorrect' : 'correct';
    base.summary = summarize(base);
    base.durationMs = Date.now() - started;
    progress({ stage: 'done', findings: base.findings.length, dropped: base.dropped.length });
    return base;
  }

  private async reviewGroup(
    g: ReviewGroup,
    total: number,
    allSelected: DiffFile[],
    rules: ProjectRule[],
    views: Map<string, FileView>,
    opts: ReviewOptions & { model: string },
    parentId: string,
    progress: (p: ReviewProgress) => void,
  ): Promise<GroupOutcome> {
    const paths = g.files.map((f) => f.path);
    let usage = emptyUsage();
    const plan = g.changedLines >= this.cfg.planThreshold ? await this.plan(g, opts).catch(() => undefined) : undefined;
    if (plan) usage = addUsage(usage, plan.usage);

    const findings: Finding[] = [];
    const state: { done?: { verdict: 'correct' | 'incorrect'; summary: string }; coverageAsked: boolean } = { coverageAsked: false };
    const changedPaths = new Map([...views.keys()].map((k) => [k, views.get(k)!]));
    const commentTool: ToolDefinition = {
      name: 'review_comment',
      toolset: 'review',
      risk: 'read',
      parallelSafe: true,
      description: 'Record one review finding on a changed file. Call once per distinct issue.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Changed file path, as shown in the diff.' },
          start_line: { type: 'integer', description: 'First line (new version of the file).' },
          end_line: { type: 'integer', description: 'Last line (keep ranges short, ≤ 10 lines).' },
          existing_code: { type: 'string', description: 'The 1-5 lines the finding is about, copied exactly from the new version.' },
          title: { type: 'string', description: 'Imperative summary, ≤ 80 characters.' },
          body: { type: 'string', description: 'One paragraph: what goes wrong, when, and how to fix it.' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['bug', 'security', 'concurrency', 'performance', 'reliability', 'compatibility', 'test', 'maintainability', 'documentation', 'style'] },
          confidence: { type: 'number', description: 'How sure you are, 0-1.' },
          suggestion: { type: 'string', description: 'Optional exact replacement for lines start_line..end_line.' },
          rule: { type: 'string', description: 'Project rule file that supports this finding, if any.' },
        },
        required: ['path', 'start_line', 'title', 'body', 'severity'],
      },
      summarize: (i) => `Finding: ${truncate(String(i.title ?? ''), 70)}`,
      async execute(input) {
        const f = toFinding(input, g.id);
        if (!f) return { content: 'path, title and body are required.', isError: true };
        const path = resolveFindingPath(f.path, changedPaths);
        if (!path) return { content: `${f.path} is not one of the changed files. Comment on the changed line that causes the problem instead. Changed files: ${[...changedPaths.keys()].slice(0, 40).join(', ')}`, isError: true };
        findings.push({ ...f, path });
        progress({ stage: 'activity', group: g.id, detail: `${f.severity}: ${truncate(f.title, 80)}` });
        return { content: `Recorded finding ${findings.length} on ${path}:${f.startLine}.` };
      },
    };
    const doneTool: ToolDefinition = {
      name: 'review_done',
      toolset: 'review',
      risk: 'read',
      description: 'Finish the review of your group: the files you reviewed, your verdict and a short summary.',
      parameters: {
        type: 'object',
        properties: {
          reviewed_files: { type: 'array', items: { type: 'string' }, description: 'Every file of your group you reviewed.' },
          verdict: { type: 'string', enum: ['correct', 'incorrect'], description: '"incorrect" when the change has a bug that blocks merging.' },
          summary: { type: 'string', description: '1-3 sentences on what the change does and its main risks.' },
        },
        required: ['verdict', 'summary'],
      },
      summarize: () => 'Review done',
      async execute(input) {
        const listed = new Set(
          (Array.isArray(input.reviewed_files) ? input.reviewed_files : [])
            .map((p: unknown) => resolveFindingPath(String(p), changedPaths))
            .filter(Boolean) as string[],
        );
        const commented = new Set(findings.map((f) => f.path));
        const missing = paths.filter((p) => !listed.has(p) && !commented.has(p));
        if (missing.length && !state.coverageAsked && missing.length < paths.length) {
          state.coverageAsked = true;
          return { content: `Not finished: review these files of your group too, then call review_done again listing them: ${missing.join(', ')}`, isError: true };
        }
        state.done = { verdict: input.verdict === 'incorrect' ? 'incorrect' : 'correct', summary: String(input.summary ?? '').trim() };
        return { content: 'Review recorded. Reply with the single word: done.' };
      },
    };

    const session = this.rt.sessions.create({
      title: `↳ Review ${g.id}/${total}: ${truncate(paths.join(', '), 60)}`,
      parentId,
      cwd: opts.cwd,
      source: 'subagent',
      model: opts.model,
      mode: 'auto-edit',
    });
    const agent = this.rt.createAgent({
      session,
      surface: 'subagent',
      depth: 1,
      definition: REVIEWER,
      autoApprove: true,
      toolFilter: { only: ['read_file', 'grep', 'glob', 'list_dir', 'repo_map'] },
      extraTools: [commentTool, doneTool],
    });
    const off = agent.events.on((e) => {
      if (e.type === 'tool_call' && !e.name.startsWith('review_')) progress({ stage: 'activity', group: g.id, detail: e.summary });
    });
    try {
      const task = this.groupTask(g, total, allSelected, rules, opts, plan?.text);
      const r = await agent.run({ text: task }, { model: opts.model, signal: opts.signal, maxIterations: this.cfg.maxIterations });
      usage = addUsage(usage, r.usage);
      if (!findings.length && !state.done) findings.push(...findingsFromText(r.text, g.id));
      const error = !state.done && (r.stopReason === 'error' || r.stopReason === 'interrupted') ? (r.error ?? r.stopReason) : undefined;
      return { findings, verdict: state.done?.verdict, summary: state.done?.summary, usage, error };
    } finally {
      off();
      this.rt.releaseAgent(session.id);
    }
  }

  private groupTask(g: ReviewGroup, total: number, all: DiffFile[], rules: ProjectRule[], opts: ReviewOptions, plan?: string): string {
    const paths = g.files.map((f) => f.path);
    const others = all.filter((f) => !paths.includes(f.path)).map((f) => `${f.path} (+${f.additions} −${f.deletions})`);
    const lists = checklistsFor(paths);
    const scoped = rulesFor(rules, paths);
    const diffs = g.files.map((f) => renderFileDiff(f, 1500)).join('\n\n');
    return [
      `Review group ${g.id} of ${total}: ${paths.length} file${paths.length === 1 ? '' : 's'}, ${g.changedLines} changed lines.`,
      opts.focus ? `\n## The author's request\n${opts.focus}` : '',
      `\n## Your files (diff with new-side line numbers; "+" added, "-" removed)\n<review_files>\n${diffs}\n</review_files>`,
      others.length ? `\n## Other files in the same change (reviewed by others; read them when your files depend on them)\n${others.slice(0, 60).join('\n')}` : '',
      plan ? `\n## Risky spots to check first\n${plan}` : '',
      `\n## Check for\n${GENERAL_CHECKS.map((c) => `- ${c}`).join('\n')}`,
      ...lists.map((l) => `\n### ${l.name}\n${l.items.map((i) => `- ${i}`).join('\n')}`),
      scoped.length ? `\n## Project review rules (cite the file in \`rule\` when a finding relies on one)\n${scoped.map((r) => `### ${r.source}${r.paths.length ? ` (applies to ${r.paths.join(', ')})` : ''}\n${r.text}`).join('\n\n')}` : '',
      `\nThe files on disk are the new version. Investigate, call review_comment for each finding, then review_done. If you cannot call tools, reply with JSON only: {"findings": [{"path", "start_line", "end_line", "existing_code", "title", "body", "severity", "category", "confidence"}], "verdict": "correct" | "incorrect", "summary": "…"}.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** A quick look at a large group: where are the risks? Steers the reviewer's reading. */
  private async plan(g: ReviewGroup, opts: ReviewOptions & { model: string }): Promise<{ text: string; usage: Usage } | undefined> {
    const res = await this.rt.providers.chat(
      {
        model: this.rt.providers.resolve(opts.model),
        system: 'You plan code reviews. From the diff, list the 3-8 places most likely to hide bugs, one line each: `path:line — what to check and why`. No preamble.',
        messages: [{ id: newId('m_'), role: 'user', parts: [{ type: 'text', text: g.files.map((f) => renderFileDiff(f, 800)).join('\n\n') }], createdAt: Date.now() }],
        tools: [],
        maxTokens: 600,
        effort: 'low',
        thinking: false,
        showThinking: false,
        signal: opts.signal,
      },
      () => undefined,
    );
    const text = textOf(res.parts).trim();
    return text ? { text: truncate(text, 3000), usage: res.usage } : undefined;
  }

  /**
   * Second opinion: a fresh model call tries to refute each finding against the actual code.
   * Only refutations on the allowed grounds remove a finding; protected subjects (security,
   * concurrency, compatibility, reliability) can only be removed when the code is not there or
   * a quoted line disproves them.
   */
  private async verify(candidates: Finding[], views: Map<string, FileView>, opts: ReviewOptions, result: ReviewResult): Promise<Finding[]> {
    if (!candidates.length) return candidates;
    const ref = this.rt.providers.resolve(this.cfg.verifyModel ?? opts.model ?? this.cfg.model ?? undefined);
    const batches: Finding[][] = [];
    for (let i = 0; i < candidates.length; i += 10) batches.push(candidates.slice(i, i + 10));
    const verdicts = new Map<string, { verdict: string; ground?: string; severity?: string; reason?: string }>();
    await mapLimit(batches, Math.max(1, this.cfg.concurrency), async (batch) => {
      const text = batch.map((f) => describeForCheck(f, views.get(f.path))).join('\n\n');
      try {
        const res = await this.rt.providers.chat(
          {
            model: ref,
            system: REFUTER_SYSTEM,
            messages: [{ id: newId('m_'), role: 'user', parts: [{ type: 'text', text }], createdAt: Date.now() }],
            tools: [],
            maxTokens: 300 + batch.length * 160,
            effort: 'medium',
            thinking: false,
            showThinking: false,
            signal: opts.signal,
          },
          () => undefined,
        );
        result.usage = addUsage(result.usage, res.usage);
        const raw = textOf(res.parts);
        const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''));
        const data = (m ? repairJson(m[0]) : undefined) as { results?: unknown } | undefined;
        for (const r of Array.isArray(data?.results) ? (data.results as Record<string, unknown>[]) : []) {
          if (r && typeof r.id === 'string') verdicts.set(r.id, { verdict: String(r.verdict ?? 'keep'), ground: r.ground ? String(r.ground).toUpperCase().slice(0, 1) : undefined, severity: r.severity ? String(r.severity) : undefined, reason: r.reason ? String(r.reason) : undefined });
        }
      } catch (e) {
        log.debug('verification failed', e);
      }
    });
    const kept: Finding[] = [];
    for (const f of candidates) {
      const v = verdicts.get(f.id);
      if (!v) {
        kept.push({ ...f, verification: { verdict: 'uncertain' } });
        continue;
      }
      const ground = v.ground ?? '';
      const allowed = PROTECTED.has(f.category) ? ground === 'A' || ground === 'B' : ['A', 'B', 'C', 'D'].includes(ground);
      if (v.verdict === 'drop' && allowed) {
        result.dropped.push({ finding: f, reason: `refuted (${ground}): ${v.reason ?? 'no reason given'}` });
        continue;
      }
      let severity = f.severity;
      if (v.severity) {
        const s = normalizeSeverity(v.severity);
        if (severityRank(s) > severityRank(severity)) severity = s;
      }
      kept.push({ ...f, severity, verification: { verdict: v.verdict === 'drop' ? 'uncertain' : 'confirmed', note: v.reason } });
    }
    return kept;
  }
}

/** One finding with the code around it, for the fact-checker. */
function describeForCheck(f: Finding, view?: FileView): string {
  const lines = view?.lines ?? (view ? newSideLines(view.diff) : []);
  const from = Math.max(1, f.startLine - 20);
  const to = Math.min(lines.length, f.endLine + 20);
  const added = new Set<number>();
  for (const h of view?.diff.hunks ?? []) for (const l of h.lines) if (l.kind === 'add' && l.newNo) added.add(l.newNo);
  const code: string[] = [];
  for (let n = from; n <= to; n++) code.push(`${String(n).padStart(5)}${added.has(n) ? '+' : ' '}${n >= f.startLine && n <= f.endLine ? '>' : ' '} ${lines[n - 1] ?? ''}`);
  const removed = (view?.diff.hunks ?? [])
    .filter((h) => h.newStart <= f.endLine + 20 && h.newStart + h.newLines >= f.startLine - 20)
    .flatMap((h) => h.lines.filter((l) => l.kind === 'del').map((l) => `      - ${l.text}`))
    .slice(0, 30);
  return [
    `## ${f.id} [${f.severity}/${f.category}] ${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ''}`,
    `${f.title}\n${f.body}`,
    `Code (new version; "+" = added by this change, ">" = the lines the finding points at):\n${code.join('\n') || '(file not available)'}`,
    removed.length ? `Lines this change removed nearby:\n${removed.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarize(r: ReviewResult): string {
  const counts = new Map<string, number>();
  for (const f of r.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const parts = ['critical', 'high', 'medium', 'low'].filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${s}`);
  const head = r.findings.length
    ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'} (${parts.join(', ')}) in ${new Set(r.findings.map((f) => f.path)).size} of ${r.reviewed.length} reviewed files.`
    : `No issues found in ${r.reviewed.length} reviewed file${r.reviewed.length === 1 ? '' : 's'}.`;
  const verdict = r.verdict === 'incorrect' ? 'Not ready to merge: fix the blocking findings first.' : r.findings.length ? 'No blocking problems; the findings are worth a look.' : 'Looks good to merge.';
  return `${head} ${verdict}`;
}
