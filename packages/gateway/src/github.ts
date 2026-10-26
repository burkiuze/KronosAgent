import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { logger, errorMessage, postPullRequestReview, reviewPullRequest, type Kronos } from '@kronos/core';
import { readBody, sendJson } from './http.js';

const log = logger('github-bot');

/**
 * The Kronos GitHub bot. With the Kronos GitHub App installed on a repository and the gateway
 * reachable from GitHub (`gateway.publicUrl`), `@kronos <request>` in an issue, pull request or
 * review comment by an owner, member or collaborator starts a run:
 *
 * 👀 on the comment → a "working on it" reply → a dedicated checkout on a fresh branch (issues) or
 * the pull request's branch → the agent works with the issue/PR as context and commits → Kronos
 * pushes, opens a pull request (issues and fork PRs) or updates the PR → the reply is edited
 * into the result. Runs on the same repository are serialized; each delivery is handled once.
 *
 * Also serves the redirects of the one-click app creation (manifest flow) and installation.
 */

interface Payload {
  action?: string;
  installation?: { id: number };
  repository?: { full_name: string; default_branch: string };
  sender?: { login: string; type: string };
  comment?: { id: number; body: string; author_association: string; user: { login: string; type: string }; path?: string; line?: number; diff_hunk?: string };
  review?: { id: number; body: string | null; author_association: string; user: { login: string; type: string } };
  issue?: { number: number; title: string; body: string | null; pull_request?: unknown; html_url: string; author_association: string; user: { login: string } };
  pull_request?: { number: number; title: string; body: string | null; html_url: string; author_association?: string; draft?: boolean; user: { login: string; type?: string } };
}

interface Job {
  repo: string;
  installation: number;
  number: number;
  isPr: boolean;
  title: string;
  body: string;
  request: string;
  author: string;
  commentId?: number;
  reviewComment?: { path?: string; line?: number; hunk?: string };
  url: string;
  /** automatic run nobody asked for: no "on it" comment, the result speaks for itself */
  quiet?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class GitHubBot {
  private seen = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private running = 0;

  constructor(private readonly rt: () => Kronos) {}

  /** Handles /hooks/github*; returns false for other paths. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/hooks/github/app-created') {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      try {
        const app = await this.rt().github.completeManifest(code, state);
        redirect(res, `/?github=created&app=${encodeURIComponent(app.slug)}`);
      } catch (e) {
        redirect(res, `/?github=error&message=${encodeURIComponent(errorMessage(e))}`);
      }
      return true;
    }
    if (url.pathname === '/hooks/github/installed') {
      redirect(res, `/?github=installed`);
      return true;
    }
    if (url.pathname !== '/hooks/github') return false;
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'POST only' });
      return true;
    }
    const raw = await readBody(req);
    const app = this.rt().github.app();
    if (!app?.webhookSecret) {
      sendJson(res, 404, { error: 'the Kronos GitHub App is not set up' });
      return true;
    }
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const want = `sha256=${createHmac('sha256', app.webhookSecret).update(raw).digest('hex')}`;
    if (!safeEqual(sig, want)) {
      sendJson(res, 401, { error: 'bad signature' });
      return true;
    }
    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '');
    let payload: Payload;
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}') as Payload;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return true;
    }
    const job = this.jobFor(event, payload);
    if (!job || (delivery && this.seen.has(delivery))) {
      sendJson(res, 200, { ok: true, ignored: true });
      return true;
    }
    if (delivery) {
      this.seen.set(delivery, Date.now());
      for (const [k, at] of this.seen) if (Date.now() - at > 24 * 3600_000) this.seen.delete(k);
    }
    sendJson(res, 202, { ok: true, accepted: true });
    // one run at a time per repository: they share a checkout
    const prev = this.queues.get(job.repo) ?? Promise.resolve();
    const next = prev.then(() => this.run(job)).catch((e) => log.warn('github job failed', e));
    this.queues.set(job.repo, next);
    void next.finally(() => {
      if (this.queues.get(job.repo) === next) this.queues.delete(job.repo);
    });
    return true;
  }

  /** The request in a webhook delivery, when it mentions Kronos and comes from someone allowed. */
  jobFor(event: string, p: Payload): Job | undefined {
    const rt = this.rt();
    const cfg = rt.config.github.bot;
    const app = rt.github.app();
    if (!cfg.enabled || !app || !p.repository || !p.installation) return undefined;
    if (p.sender?.type === 'Bot') return undefined;
    const triggers = [cfg.trigger, `@${app.slug}`].filter(Boolean).map((t) => t.toLowerCase());
    const mentions = (text: string | null | undefined) => Boolean(text && triggers.some((t) => new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)));
    const allowed = (assoc: string | undefined) => Boolean(assoc && cfg.allowed.map((a) => a.toUpperCase()).includes(assoc.toUpperCase()));
    const base = { repo: p.repository.full_name, installation: p.installation.id };

    if (event === 'issue_comment' && p.action === 'created' && p.comment && p.issue) {
      if (!mentions(p.comment.body) || !allowed(p.comment.author_association)) return undefined;
      return { ...base, number: p.issue.number, isPr: Boolean(p.issue.pull_request), title: p.issue.title, body: p.issue.body ?? '', request: p.comment.body, author: p.comment.user.login, commentId: p.comment.id, url: p.issue.html_url };
    }
    if (event === 'pull_request_review_comment' && p.action === 'created' && p.comment && p.pull_request) {
      if (!mentions(p.comment.body) || !allowed(p.comment.author_association)) return undefined;
      return {
        ...base,
        number: p.pull_request.number,
        isPr: true,
        title: p.pull_request.title,
        body: p.pull_request.body ?? '',
        request: p.comment.body,
        author: p.comment.user.login,
        reviewComment: { path: p.comment.path, line: p.comment.line, hunk: p.comment.diff_hunk },
        url: p.pull_request.html_url,
      };
    }
    if (event === 'pull_request_review' && p.action === 'submitted' && p.review && p.pull_request) {
      if (!mentions(p.review.body) || !allowed(p.review.author_association)) return undefined;
      return { ...base, number: p.pull_request.number, isPr: true, title: p.pull_request.title, body: p.pull_request.body ?? '', request: p.review.body ?? '', author: p.review.user.login, url: p.pull_request.html_url };
    }
    // github.bot.autoReview: every new (non-draft) pull request gets a review without being asked
    if (event === 'pull_request' && p.pull_request && cfg.autoReview && ['opened', 'ready_for_review', 'reopened'].includes(p.action ?? '')) {
      if (p.pull_request.draft || p.pull_request.user.type === 'Bot') return undefined;
      const pr = p.pull_request;
      return { ...base, number: pr.number, isPr: true, title: pr.title, body: pr.body ?? '', request: `${cfg.trigger} review`, author: pr.user.login, url: pr.html_url, quiet: true };
    }
    if (event === 'issues' && (p.action === 'opened' || p.action === 'assigned') && p.issue) {
      if (!mentions(`${p.issue.title}\n${p.issue.body ?? ''}`) || !allowed(p.issue.author_association)) return undefined;
      return { ...base, number: p.issue.number, isPr: false, title: p.issue.title, body: p.issue.body ?? '', request: p.issue.body ?? p.issue.title, author: p.issue.user.login, url: p.issue.html_url };
    }
    return undefined;
  }

  private async run(job: Job): Promise<void> {
    const rt = this.rt();
    const gh = rt.github;
    const token = await gh.installationToken(job.installation);
    const api = <T>(method: string, path: string, body?: unknown) => gh.request<T>(method, path, body, { token });
    if (job.commentId) await api('POST', `/repos/${job.repo}/issues/comments/${job.commentId}/reactions`, { content: 'eyes' }).catch(() => undefined);
    const status = job.quiet ? undefined : await api<{ id: number }>('POST', `/repos/${job.repo}/issues/${job.number}/comments`, { body: `🕐 **Kronos is on it** — working on @${job.author}'s request…` }).catch(() => undefined);
    const reply = async (text: string) => {
      if (job.quiet && !text.startsWith('⚠️')) return;
      const body = `${text}\n\n---\n_[Kronos Agent](https://github.com/burkiuze/KronosAgent)_`;
      if (status) await api('PATCH', `/repos/${job.repo}/issues/comments/${status.id}`, { body }).catch(() => api('POST', `/repos/${job.repo}/issues/${job.number}/comments`, { body }));
      else await api('POST', `/repos/${job.repo}/issues/${job.number}/comments`, { body }).catch(() => undefined);
    };

    this.running++;
    try {
      // "@kronos review" on a pull request: a code review with inline comments, no code changes
      if (job.isPr && this.wantsReview(job.request)) {
        const focus = job.request.replace(/@[\w-]+(\[bot\])?\s+review\b[:,]?/i, '').trim();
        const { result } = await reviewPullRequest(rt, { repo: job.repo, number: job.number }, { focus: focus || undefined, model: rt.config.github.bot.model ?? undefined });
        const posted = await postPullRequestReview(rt, { repo: job.repo, number: job.number }, result);
        const n = result.findings.length;
        await reply(
          `🔍 **Review done** — ${result.summary}${posted.url ? `\n\n[${n ? `${n} finding${n === 1 ? '' : 's'}` : 'The review'}](${posted.url})${posted.inline ? ` · ${posted.inline} inline` : ''}` : ''}\n\nAsk \`@kronos fix the review findings\` and I will push the fixes to this pull request.`,
        );
        return;
      }
      const dir = join(rt.paths.root, 'github-work', job.repo);
      await gh.clone(job.repo, { dest: dir });
      const git = (...args: string[]) => gh.git(args, dir, token);
      const repoInfo = await api<{ default_branch: string }>('GET', `/repos/${job.repo}`);

      // the branch to work on
      let branch: string;
      let base: string;
      let pushTo: { branch: string; openPr: boolean };
      let context = '';
      if (job.isPr) {
        const pr = await api<{ head: { ref: string; repo: { full_name: string } | null }; base: { ref: string } }>('GET', `/repos/${job.repo}/pulls/${job.number}`);
        base = pr.base.ref;
        const sameRepo = pr.head.repo?.full_name === job.repo;
        await git('fetch', 'origin', `pull/${job.number}/head:refs/remotes/origin/pr-${job.number}`, '--force');
        if (sameRepo) {
          branch = pr.head.ref;
          await git('checkout', '-B', branch, `origin/pr-${job.number}`);
          pushTo = { branch, openPr: false };
        } else {
          // a fork we cannot push to: propose the change as a new PR on top of it
          branch = `kronos/pr-${job.number}-${Date.now().toString(36)}`;
          await git('checkout', '-B', branch, `origin/pr-${job.number}`);
          pushTo = { branch, openPr: true };
        }
        const diffStat = await git('diff', '--stat', `origin/${base}...HEAD`);
        context = `This is pull request #${job.number} (${pr.head.ref} → ${base}). Its changes so far:\n${diffStat.output.slice(-3000)}`;
      } else {
        base = repoInfo.default_branch;
        branch = `kronos/issue-${job.number}-${Date.now().toString(36)}`;
        await git('checkout', '-B', branch, `origin/${base}`);
        pushTo = { branch, openPr: true };
      }
      await git('reset', '--hard');
      await git('clean', '-fd');
      const startSha = (await git('rev-parse', 'HEAD')).output;

      const comments = await api<{ user: { login: string }; body: string }[]>('GET', `/repos/${job.repo}/issues/${job.number}/comments?per_page=30`).catch(() => []);
      const thread = comments
        .filter((c) => c.body && !c.body.startsWith('🕐'))
        .slice(-10)
        .map((c) => `@${c.user.login}: ${c.body.slice(0, 1500)}`)
        .join('\n\n');
      const prompt = [
        `You were mentioned on GitHub in ${job.repo}, ${job.isPr ? 'pull request' : 'issue'} #${job.number}: "${job.title}" (${job.url}).`,
        '',
        `## ${job.isPr ? 'Pull request' : 'Issue'} description`,
        job.body.slice(0, 8000) || '(none)',
        ...(thread ? ['', '## Recent comments', thread] : []),
        ...(job.reviewComment?.path ? ['', `## The review comment is on ${job.reviewComment.path}${job.reviewComment.line ? `:${job.reviewComment.line}` : ''}`, '```diff', (job.reviewComment.hunk ?? '').slice(-2000), '```'] : []),
        ...(context ? ['', context] : []),
        '',
        `## Request from @${job.author}`,
        job.request.slice(0, 6000),
        '',
        '## How to work',
        `- You are in a checkout of ${job.repo} on branch \`${branch}\` (based on \`${base}\`).`,
        '- If the request needs code changes: make them, run the project\'s tests/checks, and commit with clear messages. Do not push and do not open a pull request — Kronos does that after you finish.',
        '- If it is a question or a review, answer it; do not change files then.',
        '- Your final message is posted as the reply on GitHub: concise Markdown — what you did or found, how you verified it, anything left open.',
      ].join('\n');

      const cfg = rt.config.github.bot;
      const res = await rt.runHeadless(prompt, {
        source: 'github',
        cwd: dir,
        mode: cfg.mode,
        autoApprove: true,
        model: cfg.model ?? undefined,
        title: `${job.repo}#${job.number}: ${job.title}`.slice(0, 80),
        signal: AbortSignal.timeout(Math.max(1, cfg.maxMinutes) * 60_000),
      });

      // commit whatever the agent left uncommitted
      if ((await git('status', '--porcelain')).output) {
        await git('add', '-A');
        await git('commit', '-m', `Kronos: ${job.title}`.slice(0, 72), '-m', `Requested by @${job.author} in #${job.number}`);
      }
      const ahead = Number((await git('rev-list', '--count', `${startSha}..HEAD`)).output || 0);
      let result = res.text?.trim() || (res.error ? `I could not finish: ${res.error}` : 'Done.');
      if (ahead > 0) {
        await gh.push(dir, pushTo.branch);
        if (pushTo.openPr) {
          const pr = await api<{ number: number; html_url: string }>('POST', `/repos/${job.repo}/pulls`, {
            title: job.isPr ? `Kronos: changes for #${job.number}` : `Fix #${job.number}: ${job.title}`.slice(0, 200),
            head: pushTo.branch,
            base: job.isPr ? (await api<{ head: { ref: string } }>('GET', `/repos/${job.repo}/pulls/${job.number}`)).head.ref : base,
            body: `${result}\n\n${job.isPr ? `Follow-up to #${job.number}` : `Closes #${job.number}`} — requested by @${job.author}.`,
          }).catch(async (e) => {
            // a fork's branch is not in this repository: target the PR's base instead
            if (!job.isPr) throw e;
            return api<{ number: number; html_url: string }>('POST', `/repos/${job.repo}/pulls`, { title: `Kronos: changes for #${job.number}`, head: pushTo.branch, base, body: `${result}\n\nFollow-up to #${job.number} — requested by @${job.author}.` });
          });
          result += `\n\n**Pull request:** ${pr.html_url}`;
        } else {
          result += `\n\n**Pushed ${ahead} commit${ahead === 1 ? '' : 's'}** to \`${pushTo.branch}\`.`;
        }
      }
      await reply(result);
    } catch (e) {
      log.warn(`github job ${job.repo}#${job.number} failed`, e);
      await reply(`⚠️ Kronos could not complete this: ${errorMessage(e)}`);
    } finally {
      this.running--;
    }
  }

  /** "@kronos review", "@kronos review this, focus on auth" — the mention followed by "review" */
  private wantsReview(request: string): boolean {
    const cfg = this.rt().config.github.bot;
    const app = this.rt().github.app();
    const names = [cfg.trigger, app?.slug ? `@${app.slug}` : ''].filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return names.some((n) => new RegExp(`(^|\\s)${n}(\\[bot\\])?\\s+(please\\s+)?(code[- ]?)?review\\b`, 'i').test(request));
  }

  get active(): number {
    return this.running;
  }
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}
