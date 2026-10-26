import type { ToolDefinition } from '../tools/types.js';
import type { DiffSpec } from './diff.js';
import { defaultBase } from './diff.js';
import { formatText } from './format.js';
import { parsePullRequestRef, postPullRequestReview, reviewPullRequest } from './github.js';
import type { ReviewResult, ReviewProgress } from './engine.js';
import type { Severity } from './findings.js';

export const codeReviewTool: ToolDefinition<{ target?: 'changes' | 'staged' | 'branch' | 'commit' | 'pr' | 'scan'; paths?: string[]; base?: string; commit?: string; pr?: string; post?: boolean; focus?: string; min_severity?: Severity }> = {
  name: 'code_review',
  toolset: 'review',
  risk: (i) => (i.post ? 'external' : 'read'),
  description:
    'Review code changes thoroughly: parallel reviewers read every changed file with its context, then a fact-checker tries to refute each finding. ' +
    'Returns verified findings with file:line, severity and fixes. target: "changes" (uncommitted, default), "staged", "branch" (everything since the merge base with `base`, default the main branch — like a pull request) or "commit". ' +
    'Use it when asked to review, and before finishing large changes of your own.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['changes', 'staged', 'branch', 'commit', 'pr', 'scan'] },
      paths: { type: 'array', items: { type: 'string' }, description: 'target "scan": files or directories to review whole (default: the repository).' },
      pr: { type: 'string', description: 'Pull request for target "pr": 12, owner/repo#12 or its URL.' },
      post: { type: 'boolean', description: 'target "pr": post the review on GitHub (inline comments with suggestions).' },
      base: { type: 'string', description: 'Base branch for target "branch" (default: origin/HEAD, main or master).' },
      commit: { type: 'string', description: 'Commit for target "commit".' },
      focus: { type: 'string', description: 'What the change is meant to do, or what to pay attention to.' },
      min_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    },
  },
  summarize: (i) => `Review ${i.target === 'pr' ? `pull request ${i.pr ?? ''}` : i.target === 'branch' ? `branch vs ${i.base ?? 'main'}` : i.target === 'commit' ? `commit ${i.commit ?? ''}` : i.target === 'staged' ? 'staged changes' : 'changes'}`,
  async execute(input, ctx) {
    let spec: DiffSpec = { kind: 'workspace' };
    if (input.target === 'scan') spec = { kind: 'scan', paths: input.paths ?? [] };
    else if (input.target === 'staged') spec = { kind: 'staged' };
    else if (input.target === 'commit') {
      if (!input.commit) return { content: 'commit is required for target "commit"', isError: true };
      spec = { kind: 'commit', commit: input.commit };
    } else if (input.target === 'branch') {
      const base = input.base ?? (await defaultBase(ctx.cwd));
      if (!base) return { content: 'No base branch found; pass base.', isError: true };
      spec = { kind: 'range', base };
    }
    let groups = 0;
    const onProgress = (p: ReviewProgress) => {
      if (p.stage === 'diff') {
        groups = p.groups;
        ctx.progress(`Reviewing ${p.selected} of ${p.files} files in ${p.groups} group${p.groups === 1 ? '' : 's'}…`);
      } else if (p.stage === 'group' && p.status !== 'start') ctx.progress(`Group ${p.group}/${groups} ${p.status}${p.findings ? ` · ${p.findings} candidate findings` : ''}`);
      else if (p.stage === 'activity') ctx.progress(`Group ${p.group}: ${p.detail}`);
      else if (p.stage === 'verify') ctx.progress(`Fact-checking ${p.candidates} findings…`);
    };
    const common = { focus: input.focus, minSeverity: input.min_severity, parentSessionId: ctx.sessionId, signal: ctx.signal, onProgress };
    let r: ReviewResult;
    let posted = '';
    if (input.target === 'pr') {
      if (!input.pr) return { content: 'pr is required for target "pr"', isError: true };
      const ref = await parsePullRequestRef(ctx.runtime, input.pr, ctx.cwd);
      r = (await reviewPullRequest(ctx.runtime, ref, common)).result;
      if (input.post) {
        const p = await postPullRequestReview(ctx.runtime, ref, r);
        posted = `\n\nPosted on ${ref.repo}#${ref.number}${p.url ? `: ${p.url}` : ''} (${p.inline} inline comment${p.inline === 1 ? '' : 's'}).`;
      }
    } else r = await ctx.runtime.review.run({ cwd: ctx.cwd, spec, ...common });
    return { content: formatText(r) + posted, isError: r.errors.length > 0 && !r.findings.length && r.groups > 0 && r.errors.length >= r.groups, meta: { findings: r.findings.length, verdict: r.verdict } };
  },
};
