import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Kronos } from '../runtime.js';
import { errorMessage } from '../util/misc.js';
import type { ReviewOptions, ReviewResult } from './engine.js';
import { formatMarkdown, githubReview } from './format.js';

export interface PullRequestRef {
  repo: string;
  number: number;
}

/** "owner/repo#12", "https://github.com/owner/repo/pull/12", or "12" with the repo of `cwd`. */
export async function parsePullRequestRef(rt: Kronos, ref: string, cwd: string): Promise<PullRequestRef> {
  const url = /([\w.-]+\/[\w.-]+)\/pulls?\/(\d+)/.exec(ref);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  if (short) return { repo: short[1] as string, number: Number(short[2]) };
  const n = /^#?(\d+)$/.exec(ref.trim());
  if (n) {
    const repo = await rt.github.repoOf(cwd);
    if (!repo) throw new Error('This directory is not a GitHub checkout; pass owner/repo#number or the pull request URL.');
    return { repo, number: Number(n[1]) };
  }
  throw new Error(`"${ref}" is not a pull request (use 12, owner/repo#12 or its URL)`);
}

interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

/**
 * Review a pull request in a throwaway worktree of the repository at the PR's head commit, so the
 * reviewers read exactly the code under review and the user's own checkout is never touched.
 */
export async function reviewPullRequest(
  rt: Kronos,
  pr: PullRequestRef,
  opts: Omit<ReviewOptions, 'cwd' | 'spec'> & { cwd?: string } = {},
): Promise<{ result: ReviewResult; info: PullRequestInfo }> {
  const info = await rt.github.request<PullRequestInfo>('GET', `/repos/${pr.repo}/pulls/${pr.number}`, undefined, { repo: pr.repo });
  const { path: repoDir } = await rt.github.clone(pr.repo);
  const { token } = await rt.github.tokenFor(pr.repo);
  const fetch = await rt.github.git(['fetch', 'origin', `+refs/heads/${info.base.ref}:refs/remotes/origin/${info.base.ref}`, `+refs/pull/${pr.number}/head:refs/kronos/pr-${pr.number}`], repoDir, token);
  if (!fetch.ok) throw new Error(`git fetch failed: ${fetch.output}`);
  const dir = join(repoDir, '.git', 'kronos-review', `pr-${pr.number}`);
  if (existsSync(dir)) {
    await rt.github.git(['worktree', 'remove', '--force', dir], repoDir);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(join(dir, '..'), { recursive: true });
  const add = await rt.github.git(['worktree', 'add', '--detach', dir, info.head.sha], repoDir);
  if (!add.ok) throw new Error(`could not check out the pull request: ${add.output}`);
  try {
    const focus = [`Pull request #${info.number}: ${info.title}`, (info.body ?? '').trim().slice(0, 4000), opts.focus].filter(Boolean).join('\n\n');
    const result = await rt.review.run({ ...opts, cwd: dir, spec: { kind: 'range', base: `origin/${info.base.ref}`, head: info.head.sha }, focus });
    result.headSha = info.head.sha;
    return { result, info };
  } finally {
    await rt.github.git(['worktree', 'remove', '--force', dir], repoDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Post the review on the pull request: inline comments with one-click suggestions where the
 * finding sits on a changed line, everything else in the review body. If GitHub rejects an
 * inline position (the diff moved on), the whole review is posted as one comment instead.
 */
export async function postPullRequestReview(rt: Kronos, pr: PullRequestRef, result: ReviewResult, opts: { requestChanges?: boolean } = {}): Promise<{ url?: string; inline: number }> {
  const payload = githubReview(result, opts);
  try {
    const res = await rt.github.request<{ html_url?: string }>('POST', `/repos/${pr.repo}/pulls/${pr.number}/reviews`, payload, { repo: pr.repo });
    return { url: res.html_url, inline: payload.comments.length };
  } catch (e) {
    if (!payload.comments.length) throw e;
    const body = `${formatMarkdown(result)}\n\n<sub>(inline comments could not be placed: ${errorMessage(e).slice(0, 200)})</sub>`;
    const res = await rt.github.request<{ html_url?: string }>('POST', `/repos/${pr.repo}/pulls/${pr.number}/reviews`, { commit_id: payload.commit_id, event: payload.event, body, comments: [] }, { repo: pr.repo });
    return { url: res.html_url, inline: 0 };
  }
}
