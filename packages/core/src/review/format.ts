import type { ReviewResult } from './engine.js';
import type { Finding, Severity } from './findings.js';

const ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

function where(f: Finding): string {
  return `${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ''}`;
}

/** Plain text for terminals and tool results. */
export function formatText(r: ReviewResult, opts: { dropped?: boolean } = {}): string {
  const out: string[] = [`Code review of ${r.label}: ${r.summary}`];
  for (const f of r.findings) {
    out.push('');
    out.push(`[${f.severity.toUpperCase()}] ${where(f)} — ${f.title}  (${f.category}${f.verification?.verdict === 'confirmed' ? ', verified' : ''})`);
    out.push(`  ${f.body.replace(/\n/g, '\n  ')}`);
    if (f.suggestion) out.push(`  Suggested replacement:\n${f.suggestion.split('\n').map((l) => `    ${l}`).join('\n')}`);
    if (f.rule) out.push(`  Rule: ${f.rule}`);
  }
  if (r.notes.length) out.push('', 'Reviewer notes:', ...r.notes.map((n) => `- ${n}`));
  if (r.skipped.length) out.push('', `Not reviewed: ${r.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
  if (opts.dropped && r.dropped.length) out.push('', 'Dropped:', ...r.dropped.map((d) => `- ${where(d.finding)} ${d.finding.title} — ${d.reason}`));
  if (r.errors.length) out.push('', `Problems: ${r.errors.join('; ')}`);
  return out.join('\n');
}

function suggestionBlock(f: Finding): string {
  return f.suggestion !== undefined ? `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n$/, '')}\n\`\`\`` : '';
}

/** One finding as a pull request review comment body. */
export function commentBody(f: Finding): string {
  return `${ICON[f.severity]} **${f.title}** · _${f.severity} · ${f.category}_\n\n${f.body}${f.rule ? `\n\n_Rule: ${f.rule}_` : ''}${suggestionBlock(f)}`;
}

/** Markdown report (also the body of a pull request review). */
export function formatMarkdown(r: ReviewResult, opts: { inline?: Set<string>; footer?: string } = {}): string {
  const out: string[] = [`## Kronos code review\n\n${r.summary}`];
  const listed = r.findings.filter((f) => !opts.inline?.has(f.id));
  if (listed.length) {
    out.push('');
    if (opts.inline?.size) out.push(`${opts.inline.size} finding${opts.inline.size === 1 ? ' is' : 's are'} commented inline. ${listed.length === 1 ? 'This one is' : 'These are'} outside the changed lines:\n`);
    for (const f of listed) {
      out.push(`### ${ICON[f.severity]} ${f.title}\n\`${where(f)}\` · ${f.severity} · ${f.category}\n\n${f.body}${f.rule ? `\n\n_Rule: ${f.rule}_` : ''}${f.suggestion ? `\n\n\`\`\`\n${f.suggestion}\n\`\`\`` : ''}\n`);
    }
  }
  if (r.notes.length) out.push(`<details><summary>Reviewer notes</summary>\n\n${r.notes.map((n) => `- ${n}`).join('\n')}\n\n</details>`);
  if (r.skipped.length) out.push(`<details><summary>${r.skipped.length} file${r.skipped.length === 1 ? '' : 's'} not reviewed</summary>\n\n${r.skipped.map((s) => `- \`${s.path}\` — ${s.reason}`).join('\n')}\n\n</details>`);
  if (r.errors.length) out.push(`> ⚠️ ${r.errors.join('; ')}`);
  out.push(opts.footer ?? `<sub>${r.reviewed.length} files reviewed · ${r.dropped.length} candidate findings refuted or filtered · ${Math.round(r.durationMs / 1000)}s</sub>`);
  return out.join('\n');
}

export function formatJson(r: ReviewResult): string {
  return JSON.stringify(
    {
      label: r.label,
      head: r.headSha,
      verdict: r.verdict,
      summary: r.summary,
      findings: r.findings.map((f) => ({
        id: f.id,
        path: f.path,
        start_line: f.startLine,
        end_line: f.endLine,
        title: f.title,
        body: f.body,
        severity: f.severity,
        category: f.category,
        confidence: f.confidence,
        suggestion: f.suggestion,
        rule: f.rule,
        in_diff: f.inDiff,
        verified: f.verification?.verdict === 'confirmed',
      })),
      reviewed: r.reviewed,
      skipped: r.skipped,
      dropped: r.dropped.map((d) => ({ path: d.finding.path, line: d.finding.startLine, title: d.finding.title, reason: d.reason })),
      notes: r.notes,
      errors: r.errors,
      usage: r.usage,
      duration_ms: r.durationMs,
      model: r.model,
    },
    null,
    2,
  );
}

/** SARIF 2.1.0 — GitHub code scanning, IDEs and other tools read it. */
export function formatSarif(r: ReviewResult, version = '1.0.0'): string {
  const level = (s: Severity) => (s === 'critical' || s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'note');
  const rules = [...new Set(r.findings.map((f) => f.category))].map((c) => ({ id: `kronos/${c}`, name: c, shortDescription: { text: `Kronos review: ${c}` } }));
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'Kronos code review', informationUri: 'https://github.com/burkiuze/KronosAgent', version, rules } },
          results: r.findings.map((f) => ({
            ruleId: `kronos/${f.category}`,
            level: level(f.severity),
            message: { text: `${f.title}\n\n${f.body}` },
            locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.startLine, endLine: f.endLine } } }],
            properties: { severity: f.severity, confidence: f.confidence, verified: f.verification?.verdict === 'confirmed' },
            ...(f.suggestion !== undefined
              ? { fixes: [{ description: { text: f.title }, artifactChanges: [{ artifactLocation: { uri: f.path }, replacements: [{ deletedRegion: { startLine: f.startLine, endLine: f.endLine }, insertedContent: { text: `${f.suggestion.replace(/\n$/, '')}\n` } }] }] }] }
              : {}),
          })),
        },
      ],
    },
    null,
    2,
  );
}

export interface GitHubReviewPayload {
  commit_id?: string;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  body: string;
  comments: { path: string; line: number; start_line?: number; side: 'RIGHT'; start_side?: 'RIGHT'; body: string }[];
}

/**
 * A pull request review: findings on changed lines become inline comments (with suggestion blocks
 * GitHub can apply in one click); the rest go into the review body. Never approves on its own.
 */
export function githubReview(r: ReviewResult, opts: { requestChanges?: boolean } = {}): GitHubReviewPayload {
  const inline = r.findings.filter((f) => f.inDiff);
  const comments = inline.map((f) => ({
    path: f.path,
    line: f.endLine,
    ...(f.endLine > f.startLine ? { start_line: f.startLine, start_side: 'RIGHT' as const } : {}),
    side: 'RIGHT' as const,
    body: commentBody(f),
  }));
  return {
    commit_id: r.headSha,
    event: opts.requestChanges && r.verdict === 'incorrect' ? 'REQUEST_CHANGES' : 'COMMENT',
    body: formatMarkdown(r, { inline: new Set(inline.map((f) => f.id)) }),
    comments,
  };
}
