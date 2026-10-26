import { writeFileSync } from 'node:fs';
import {
  KRONOS_VERSION,
  defaultBase,
  formatJson,
  formatMarkdown,
  formatSarif,
  formatText,
  githubReview,
  normalizeSeverity,
  parsePullRequestRef,
  postPullRequestReview,
  reviewPullRequest,
  severityRank,
  type DiffSpec,
  type Kronos,
  type ReviewProgress,
  type ReviewResult,
} from '@kronos/core';
import { flagStr, type ParsedArgs } from './args.js';
import { c, sym } from './ui/ansi.js';

export const REVIEW_HELP = `${c.bold('kronos review')} — review code changes

  kronos review                    uncommitted changes (staged, unstaged and new files)
  kronos review --staged           staged changes only
  kronos review --base main        everything since the merge base with main (like a pull request)
  kronos review --commit <sha>     one commit
  kronos review --pr <n|url>       a GitHub pull request (in a throwaway worktree)
  kronos review --diff file.patch  a patch file ("-" reads stdin)
  kronos review --scan [paths]     whole files, no diff (a directory, files, or the repository)
  kronos review … --preview        list what would be reviewed, without calling a model

  --focus "<text>"        what the change should do / what to look at
  --format text|markdown|json|sarif|github   (default text)
  --out <file>            write the report to a file
  --post                  with --pr: post the review on GitHub with inline comments
  --request-changes       with --post: request changes when the verdict is "incorrect"
  --min-severity <level>  critical|high|medium|low (default from review.minSeverity)
  --fail-on <level>       exit 1 when a finding at or above this severity remains (CI)
  --no-verify             skip the fact-checking pass
  --show-dropped          also list findings that were refuted or filtered
  -m, --model <ref>       model for the reviewers`;

const COLOR = { critical: c.red, high: c.red, medium: c.yellow, low: c.cyan } as const;

function progressLine(p: ReviewProgress, state: { groups: number }): string | undefined {
  switch (p.stage) {
    case 'diff':
      state.groups = p.groups;
      return `${c.bold('Reviewing')} ${p.label}: ${p.selected} of ${p.files} files in ${p.groups} group${p.groups === 1 ? '' : 's'}`;
    case 'group':
      if (p.status === 'start') return c.gray(`  ${sym.bullet} group ${p.group}/${state.groups}: ${p.files.join(', ')}`);
      return p.status === 'error' ? c.yellow(`  ${sym.warn} group ${p.group} failed: ${p.detail}`) : c.gray(`  ${sym.ok} group ${p.group}/${state.groups} done · ${p.findings ?? 0} candidates`);
    case 'activity':
      return c.gray(`    ${p.detail}`);
    case 'verify':
      return p.candidates ? `${c.bold('Fact-checking')} ${p.candidates} finding${p.candidates === 1 ? '' : 's'}` : undefined;
    default:
      return undefined;
  }
}

function printText(r: ReviewResult, showDropped: boolean): void {
  const verdict = r.verdict === 'incorrect' ? c.red('changes needed') : c.green('looks good');
  console.log(`\n${c.bold('Review')} ${r.label} · ${verdict}\n${r.summary}`);
  for (const f of r.findings) {
    const color = COLOR[f.severity];
    console.log(`\n${color(f.severity.toUpperCase())} ${c.bold(f.title)} ${c.gray(`${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ''} · ${f.category}${f.verification?.verdict === 'confirmed' ? ' · verified' : ''}`)}`);
    console.log(`  ${f.body.replace(/\n/g, '\n  ')}`);
    if (f.suggestion) console.log(c.green(f.suggestion.split('\n').map((l) => `  + ${l}`).join('\n')));
    if (f.rule) console.log(c.gray(`  rule: ${f.rule}`));
  }
  if (r.notes.length) console.log(`\n${c.bold('Notes')}\n${r.notes.map((n) => `  - ${n}`).join('\n')}`);
  if (r.skipped.length) console.log(c.gray(`\nNot reviewed: ${r.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}`));
  if (showDropped && r.dropped.length) console.log(c.gray(`\nDropped:\n${r.dropped.map((d) => `  - ${d.finding.path}:${d.finding.startLine} ${d.finding.title} — ${d.reason}`).join('\n')}`));
  for (const e of r.errors) console.log(c.yellow(`${sym.warn} ${e}`));
  const tokens = r.usage.inputTokens + r.usage.outputTokens;
  console.log(c.gray(`\n${r.reviewed.length} files · ${r.groups} reviewers · ${tokens.toLocaleString()} tokens · ${(r.durationMs / 1000).toFixed(1)}s · ${r.model}`));
}

export async function cmdReview(rt: Kronos, args: ParsedArgs): Promise<void> {
  let specOverride: DiffSpec | undefined;
  if (args.flags.help) return void console.log(REVIEW_HELP);
  const cwd = rt.cwd;
  const format = (flagStr(args, 'format') ?? 'text').toLowerCase();
  const state = { groups: 0 };
  const onProgress = (p: ReviewProgress) => {
    const line = progressLine(p, state);
    if (line) process.stderr.write(`${line}\n`);
  };
  const minSev = flagStr(args, 'min-severity');
  const common = {
    model: flagStr(args, 'model'),
    focus: flagStr(args, 'focus'),
    verify: args.flags.verify === false ? false : undefined,
    minSeverity: minSev ? normalizeSeverity(minSev) : undefined,
    onProgress,
  };
  const ready = rt.providers.readiness(common.model);
  if (!ready.ok && !args.flags.preview) {
    console.error(c.red(`${sym.fail} No model is connected. Run \`kronos setup\` or \`kronos keys set\` first.`));
    process.exitCode = 2;
    return;
  }

  let result: ReviewResult;
  const pr = flagStr(args, 'pr');
  if (args.flags.scan !== undefined) {
    const paths = [...(typeof args.flags.scan === 'string' ? [args.flags.scan] : []), ...args._.slice(1)].flatMap((p) => p.split(',')).filter(Boolean);
    specOverride = { kind: 'scan', paths };
  }
  if (pr) {
    const ref = await parsePullRequestRef(rt, pr, cwd);
    result = (await reviewPullRequest(rt, ref, common)).result;
    if (args.flags.post) {
      const posted = await postPullRequestReview(rt, ref, result, { requestChanges: Boolean(args.flags['request-changes']) });
      process.stderr.write(`${c.green(sym.ok)} Posted on ${ref.repo}#${ref.number}${posted.url ? ` — ${posted.url}` : ''} (${posted.inline} inline)\n`);
    }
  } else {
    let spec: DiffSpec = specOverride ?? { kind: 'workspace' };
    const diffFile = flagStr(args, 'diff');
    if (diffFile) {
      const { readFileSync } = await import('node:fs');
      spec = { kind: 'raw', diff: diffFile === '-' ? readFileSync(0, 'utf8') : readFileSync(diffFile, 'utf8') };
    } else if (args.flags.staged) spec = { kind: 'staged' };
    else if (flagStr(args, 'commit')) spec = { kind: 'commit', commit: flagStr(args, 'commit')! };
    else if (args.flags.base !== undefined) {
      const base = typeof args.flags.base === 'string' ? args.flags.base : await defaultBase(cwd);
      if (!base) throw new Error('No base branch found; pass --base <branch>.');
      spec = { kind: 'range', base, head: flagStr(args, 'head') };
    }
    if (args.flags.preview) {
      const p = await rt.review.preview({ cwd, spec });
      console.log(`${c.bold('Preview')} ${p.label}: ${p.groups.reduce((n, g) => n + g.files.length, 0)} files in ${p.groups.length} reviewer group${p.groups.length === 1 ? '' : 's'}, ${p.changedLines.toLocaleString()} lines`);
      for (const g of p.groups) console.log(`  ${c.gray(`group ${g.id} (${g.changedLines} lines)`)} ${g.files.join(', ')}`);
      if (p.skipped.length) console.log(c.gray(`  not reviewed: ${p.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}`));
      return;
    }
    result = await rt.review.run({ cwd, spec, ...common });
  }

  let report: string | undefined;
  if (format === 'json') report = formatJson(result);
  else if (format === 'sarif') report = formatSarif(result, KRONOS_VERSION);
  else if (format === 'markdown' || format === 'md') report = formatMarkdown(result);
  else if (format === 'github') report = JSON.stringify(githubReview(result), null, 2);
  else if (flagStr(args, 'out')) report = formatText(result, { dropped: Boolean(args.flags['show-dropped']) });

  const out = flagStr(args, 'out');
  if (out && report !== undefined) {
    writeFileSync(out, report);
    process.stderr.write(`${c.green(sym.ok)} Report written to ${out}\n`);
  } else if (report !== undefined) console.log(report);
  if (format === 'text' || out) printText(result, Boolean(args.flags['show-dropped']));

  const failOn = flagStr(args, 'fail-on');
  if (failOn) {
    const limit = severityRank(normalizeSeverity(failOn));
    if (result.findings.some((f) => severityRank(f.severity) <= limit)) process.exitCode = 1;
  }
}
