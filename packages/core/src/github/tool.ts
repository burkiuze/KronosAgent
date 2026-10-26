import type { ToolDefinition, ToolContext } from '../tools/types.js';
import type { ToolOutput, ToolRisk } from '../types.js';
import { resolvePath } from '../config/paths.js';
import { truncate } from '../util/text.js';
import { GitHubError } from './github.js';

type Action =
  | 'status'
  | 'repos'
  | 'clone'
  | 'push'
  | 'create_pr'
  | 'pr'
  | 'prs'
  | 'diff'
  | 'review_comments'
  | 'issue'
  | 'issues'
  | 'comment'
  | 'create_issue'
  | 'checks';

interface Input {
  action: Action;
  repo?: string;
  path?: string;
  number?: number;
  query?: string;
  branch?: string;
  base?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  force?: boolean;
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  ref?: string;
}

const READ: Action[] = ['status', 'repos', 'pr', 'prs', 'diff', 'review_comments', 'issue', 'issues', 'checks'];
const FOOTER = '\n\n---\n_By [Kronos Agent](https://github.com/burkiuze/KronosAgent)_';

const ok = (content: string, meta?: ToolOutput['meta']): ToolOutput => ({ content, meta });

/** The repository an action is about: given, or the `origin` of the working tree. */
async function repoFor(input: Input, ctx: ToolContext): Promise<string> {
  if (input.repo) return input.repo.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
  const repo = await ctx.runtime.github.repoOf(resolvePath(input.path ?? '.', ctx.cwd));
  if (!repo) throw new GitHubError('Pass repo ("owner/name"): the working directory is not a GitHub checkout.', 400);
  return repo;
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === null || v === '') throw new GitHubError(`${what} is required for this action`, 400);
  return v;
};

type Issue = { number: number; title: string; state: string; user: { login: string }; labels: { name: string }[]; body: string | null; html_url: string; comments: number; pull_request?: unknown; created_at: string };

export const githubTool: ToolDefinition<Input> = {
  name: 'github',
  toolset: 'github',
  risk: (i): ToolRisk => (READ.includes(i.action) ? 'read' : i.action === 'clone' ? 'write' : 'external'),
  parallelSafe: false,
  description:
    'Work with GitHub repositories as the connected account or the Kronos GitHub App. Actions: ' +
    'status (who is connected); repos (repositories you can work on, optional query); clone (repo → local checkout path; work there); ' +
    'push (push the current branch of path, sets upstream); create_pr (title, body, optional branch=head, base, draft; from the checkout at path); ' +
    'pr / diff / review_comments (number); prs (state); issue (number, with comments); issues (state, labels); comment (number, body; works for issues and PRs); ' +
    'create_issue (title, body, labels); checks (CI status of ref, default HEAD of path). ' +
    'repo ("owner/name") defaults to the origin of path/working directory. Plain `git` in the shell is authenticated too. ' +
    'Typical change: clone → create a branch → edit, test and commit → push → create_pr.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'repos', 'clone', 'push', 'create_pr', 'pr', 'prs', 'diff', 'review_comments', 'issue', 'issues', 'comment', 'create_issue', 'checks'] },
      repo: { type: 'string', description: 'owner/name (default: origin of path or the working directory)' },
      path: { type: 'string', description: 'Local checkout (default: working directory)' },
      number: { type: 'integer', description: 'Issue or pull request number' },
      query: { type: 'string', description: 'Filter for repos' },
      branch: { type: 'string', description: 'clone: branch to check out; push / create_pr: the branch (default: current)' },
      base: { type: 'string', description: 'create_pr: target branch (default: the repository default branch)' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Markdown body (create_pr, comment, create_issue)' },
      draft: { type: 'boolean' },
      force: { type: 'boolean', description: 'push: --force-with-lease (only for your own branches)' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      labels: { type: 'array', items: { type: 'string' } },
      ref: { type: 'string', description: 'checks: branch, tag or SHA' },
    },
    required: ['action'],
  },
  summarize: (i) => `GitHub ${i.action.replace('_', ' ')}${i.number ? ` #${i.number}` : ''}${i.repo ? ` ${i.repo}` : ''}`,
  async execute(input, ctx) {
    const gh = ctx.runtime.github;
    const cwd = resolvePath(input.path ?? '.', ctx.cwd);
    try {
      switch (input.action) {
        case 'status': {
          const s = await gh.status();
          const lines = [
            s.user ? `Connected as ${s.user.login}${s.user.name ? ` (${s.user.name})` : ''} via ${s.user.source === 'gh' ? 'the GitHub CLI' : 'a token'}.` : 'No personal GitHub token.',
            s.app ? `Kronos GitHub App "${s.app.slug}" installed on: ${s.app.installations.map((i) => `${i.account} (${i.repositories})`).join(', ') || 'nothing yet'}.` : 'Kronos GitHub App: not set up.',
          ];
          if (s.error) lines.push(`Error: ${s.error}`);
          return ok(lines.join('\n'));
        }
        case 'repos': {
          const list = await gh.repos(input.query);
          if (!list.length) return ok('No repositories found.');
          return ok(list.slice(0, 60).map((r) => `${r.fullName}${r.private ? ' (private)' : ''} — ${r.defaultBranch}${r.description ? ` — ${truncate(r.description, 80)}` : ''}`).join('\n') + (list.length > 60 ? `\n… ${list.length - 60} more (use query)` : ''));
        }
        case 'clone': {
          const repo = need(input.repo, 'repo');
          const dest = input.path ? resolvePath(input.path, ctx.cwd) : undefined;
          const r = await gh.clone(repo, { dest, branch: input.branch });
          return ok(`${r.updated ? 'Updated' : 'Cloned'} ${repo} at ${r.path}${r.kind === 'app' ? ' (as the Kronos GitHub App)' : ''}. Work in that directory (pass it as cwd/path).`, { path: r.path });
        }
        case 'push': {
          const r = await gh.push(cwd, input.branch, input.force);
          return ok(`Pushed ${r.branch} to ${r.repo}.\n${truncate(r.output, 1500)}`);
        }
        case 'create_pr': {
          const repo = await repoFor(input, ctx);
          const head = input.branch ?? (await gh.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).output;
          if (!head || head === 'HEAD') throw new GitHubError('Not on a branch: pass branch or check one out.', 400);
          const info = await gh.request<{ default_branch: string }>('GET', `/repos/${repo}`, undefined, { repo });
          const base = input.base ?? info.default_branch;
          if (head === base) throw new GitHubError(`The branch is the base branch (${base}): create a feature branch, commit there, push it, then open the PR.`, 400);
          const pr = await gh.request<{ number: number; html_url: string }>(
            'POST',
            `/repos/${repo}/pulls`,
            { title: need(input.title, 'title'), body: `${input.body ?? ''}${FOOTER}`, head, base, draft: Boolean(input.draft) },
            { repo },
          );
          return ok(`Opened pull request #${pr.number}: ${pr.html_url}`, { url: pr.html_url });
        }
        case 'pr': {
          const repo = await repoFor(input, ctx);
          const n = need(input.number, 'number');
          type Pr = Issue & { head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string }; mergeable_state?: string; additions: number; deletions: number; changed_files: number; draft: boolean; merged: boolean };
          const pr = await gh.request<Pr>('GET', `/repos/${repo}/pulls/${n}`, undefined, { repo });
          const files = await gh.request<{ filename: string; status: string; additions: number; deletions: number }[]>('GET', `/repos/${repo}/pulls/${n}/files?per_page=100`, undefined, { repo });
          const comments = await gh.request<{ user: { login: string }; body: string; created_at: string }[]>('GET', `/repos/${repo}/issues/${n}/comments?per_page=50`, undefined, { repo });
          return ok(
            [
              `#${pr.number} ${pr.title} [${pr.merged ? 'merged' : pr.state}${pr.draft ? ', draft' : ''}] by ${pr.user.login}`,
              `${pr.head.repo?.full_name ?? '?'}:${pr.head.ref} → ${pr.base.ref} · +${pr.additions} −${pr.deletions} in ${pr.changed_files} file(s) · ${pr.html_url}`,
              '',
              truncate(pr.body ?? '(no description)', 4000),
              '',
              'Files:',
              ...files.map((f) => `  ${f.status.padEnd(9)} ${f.filename} (+${f.additions} −${f.deletions})`),
              ...(comments.length ? ['', 'Comments:', ...comments.slice(-20).map((c) => `— ${c.user.login}: ${truncate(c.body, 800)}`)] : []),
            ].join('\n'),
            { url: pr.html_url },
          );
        }
        case 'diff': {
          const repo = await repoFor(input, ctx);
          const diff = await gh.request<string>('GET', `/repos/${repo}/pulls/${need(input.number, 'number')}`, undefined, { repo, accept: 'application/vnd.github.diff' });
          return ok(typeof diff === 'string' ? diff : JSON.stringify(diff));
        }
        case 'review_comments': {
          const repo = await repoFor(input, ctx);
          const list = await gh.request<{ user: { login: string }; path: string; line: number | null; body: string; diff_hunk: string }[]>('GET', `/repos/${repo}/pulls/${need(input.number, 'number')}/comments?per_page=100`, undefined, { repo });
          if (!list.length) return ok('No review comments.');
          return ok(list.map((c) => `${c.path}:${c.line ?? '?'} — ${c.user.login}:\n${truncate(c.body, 1200)}`).join('\n\n'));
        }
        case 'prs':
        case 'issues': {
          const repo = await repoFor(input, ctx);
          const state = input.state ?? 'open';
          const path =
            input.action === 'prs'
              ? `/repos/${repo}/pulls?state=${state}&per_page=50`
              : `/repos/${repo}/issues?state=${state}&per_page=50${input.labels?.length ? `&labels=${encodeURIComponent(input.labels.join(','))}` : ''}`;
          const list = await gh.request<Issue[]>('GET', path, undefined, { repo });
          const items = input.action === 'issues' ? list.filter((i) => !i.pull_request) : list;
          if (!items.length) return ok(`No ${state} ${input.action === 'prs' ? 'pull requests' : 'issues'}.`);
          return ok(items.map((i) => `#${i.number} ${i.title} — ${i.user.login}${i.labels.length ? ` [${i.labels.map((l) => l.name).join(', ')}]` : ''}`).join('\n'));
        }
        case 'issue': {
          const repo = await repoFor(input, ctx);
          const n = need(input.number, 'number');
          const issue = await gh.request<Issue>('GET', `/repos/${repo}/issues/${n}`, undefined, { repo });
          const comments = issue.comments ? await gh.request<{ user: { login: string }; body: string }[]>('GET', `/repos/${repo}/issues/${n}/comments?per_page=50`, undefined, { repo }) : [];
          return ok(
            [
              `#${issue.number} ${issue.title} [${issue.state}] by ${issue.user.login}${issue.labels.length ? ` · ${issue.labels.map((l) => l.name).join(', ')}` : ''} · ${issue.html_url}`,
              '',
              truncate(issue.body ?? '(no description)', 6000),
              ...(comments.length ? ['', 'Comments:', ...comments.slice(-30).map((c) => `— ${c.user.login}: ${truncate(c.body, 1000)}`)] : []),
            ].join('\n'),
            { url: issue.html_url },
          );
        }
        case 'comment': {
          const repo = await repoFor(input, ctx);
          const c = await gh.request<{ html_url: string }>('POST', `/repos/${repo}/issues/${need(input.number, 'number')}/comments`, { body: `${need(input.body, 'body')}${FOOTER}` }, { repo });
          return ok(`Commented: ${c.html_url}`, { url: c.html_url });
        }
        case 'create_issue': {
          const repo = await repoFor(input, ctx);
          const i = await gh.request<{ number: number; html_url: string }>('POST', `/repos/${repo}/issues`, { title: need(input.title, 'title'), body: `${input.body ?? ''}${FOOTER}`, labels: input.labels }, { repo });
          return ok(`Created issue #${i.number}: ${i.html_url}`, { url: i.html_url });
        }
        case 'checks': {
          const repo = await repoFor(input, ctx);
          const ref = input.ref ?? (await gh.git(['rev-parse', 'HEAD'], cwd)).output;
          if (!ref) throw new GitHubError('Pass ref (branch, tag or SHA).', 400);
          const runs = await gh.request<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] }>('GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`, undefined, { repo });
          const status = await gh.request<{ state: string; statuses: { context: string; state: string }[] }>('GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}/status`, undefined, { repo });
          const lines = [
            ...runs.check_runs.map((r) => `${(r.conclusion ?? r.status).padEnd(11)} ${r.name}${r.conclusion === 'failure' ? ` — ${r.html_url}` : ''}`),
            ...status.statuses.map((s) => `${s.state.padEnd(11)} ${s.context}`),
          ];
          const failing = runs.check_runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out').length + status.statuses.filter((s) => s.state === 'failure' || s.state === 'error').length;
          const pending = runs.check_runs.filter((r) => r.status !== 'completed').length + status.statuses.filter((s) => s.state === 'pending').length;
          return ok(`${lines.length ? `${failing ? `${failing} failing` : pending ? `${pending} pending` : 'all passing'} (${lines.length} checks on ${ref.slice(0, 12)})` : `No checks on ${ref.slice(0, 12)}`}\n${lines.join('\n')}`);
        }
        default:
          return { content: `Unknown action ${(input as { action: string }).action}`, isError: true };
      }
    } catch (e) {
      return { content: e instanceof GitHubError ? e.message : `GitHub: ${(e as Error).message}`, isError: true };
    }
  },
};
