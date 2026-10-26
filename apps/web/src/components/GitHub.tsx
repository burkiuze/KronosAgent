import { useCallback, useEffect, useState } from 'react';
import { Bot, ExternalLink, FolderGit2, Github, Lock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { del, get, post } from '../lib/api';
import { loadSession, openSession, refreshSessions, setState, toast, useStore } from '../lib/store';
import { cfgGet, updateConfig, useConfig } from '../lib/config';
import { Badge, Modal, Toggle } from './ui';

interface GitHubStatus {
  connected: boolean;
  user?: { login: string; name?: string; avatarUrl?: string; source: 'kronos' | 'token' | 'gh' };
  official?: { slug: string; installUrl: string; installations?: number };
  app?: { slug: string; name: string; htmlUrl: string; installUrl: string; settingsUrl: string; installations: { id: number; account: string; repositories: 'all' | 'selected' }[]; webhook: boolean };
  error?: string;
}

/** "Connect GitHub" in one click: GitHub's device flow through the official Kronos app. */
function ConnectGitHub({ status, onChanged }: { status: GitHubStatus | null; onChanged: () => Promise<void> }) {
  const [flow, setFlow] = useState<{ handle: string; userCode: string; verificationUri: string; interval: number } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const signedIn = status?.user?.source === 'kronos' ? status.user : undefined;

  useEffect(() => {
    if (!flow) return;
    let stop = false;
    let delay = flow.interval;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await post<{ status: string; login?: string; interval?: number }>('/api/github/connect/poll', { handle: flow.handle });
        if (r.status === 'done') {
          toast(`Connected to GitHub as ${r.login}`, 'ok');
          setFlow(null);
          setWaiting(false);
          await onChanged();
          return;
        }
        if (r.status === 'expired' || r.status === 'denied') {
          toast(r.status === 'denied' ? 'GitHub sign-in was cancelled' : 'The sign-in code expired — try again', 'error');
          setFlow(null);
          setWaiting(false);
          return;
        }
        if (r.interval) delay = r.interval;
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      setTimeout(() => void tick(), delay * 1000);
    };
    const t = setTimeout(() => void tick(), delay * 1000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [flow, onChanged]);

  const start = async () => {
    setWaiting(true);
    try {
      const f = await post<{ handle: string; userCode: string; verificationUri: string; interval: number }>('/api/github/connect/start');
      setFlow(f);
      setCopied(false);
    } catch (e) {
      toast((e as Error).message, 'error');
      setWaiting(false);
    }
  };
  const copyAndOpen = async () => {
    if (!flow) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
    } catch {
      /* clipboard blocked: the code is on screen */
    }
    window.open(flow.verificationUri, '_blank', 'noopener');
  };

  return (
    <section className="gh-card gh-connect">
      <div className="gh-connect-head">
        <img src="./github-app-logo.png" alt="" width={44} height={44} className="gh-logo" />
        <div>
          <b>Connect GitHub</b>
          <span className="gh-dim">Sign in once and Kronos can work on your repositories — clone, commit, push and open pull requests, shown on GitHub with the Kronos badge.</span>
        </div>
      </div>
      {signedIn ? (
        <>
          <div className="gh-row gh-user">
            {signedIn.avatarUrl && <img src={signedIn.avatarUrl} alt="" width={28} height={28} />}
            <span>
              Connected as <b>{signedIn.login}</b> <span className="gh-dim">through Kronos</span>
            </span>
            <span className="flex-1" />
            <button
              className="btn"
              onClick={async () => {
                await del('/api/github/token');
                await onChanged();
              }}
            >
              Disconnect
            </button>
          </div>
          {status?.official && (
            <div className="gh-actions">
              <a className="btn primary" href={status.official.installUrl} target="_blank" rel="noreferrer">
                {status.official.installations ? 'Choose repositories' : 'Install Kronos on your repositories'} <ExternalLink size={12} />
              </a>
              {status.official.installations === 0 && <span className="gh-dim">Pick the repositories Kronos may work on — then they show up under + → Open a GitHub repository.</span>}
            </div>
          )}
        </>
      ) : flow ? (
        <div className="gh-device">
          <span className="gh-dim">Enter this code on GitHub:</span>
          <code className="gh-code">{flow.userCode}</code>
          <div className="gh-actions">
            <button className="btn primary" onClick={() => void copyAndOpen()}>
              <Github size={14} /> {copied ? 'Code copied — open GitHub again' : 'Copy code & open GitHub'}
            </button>
            <button className="btn" onClick={() => (setFlow(null), setWaiting(false))}>
              Cancel
            </button>
          </div>
          <span className="gh-dim gh-wait">
            <RefreshCw size={12} className="spin" /> Waiting for you to approve on GitHub…
          </span>
        </div>
      ) : status?.official ? (
        <div className="gh-actions">
          <button className="btn primary gh-big" onClick={() => void start()} disabled={waiting}>
            <Github size={16} /> Connect GitHub
          </button>
        </div>
      ) : (
        <p className="set-desc">
          One-click connect uses the official Kronos GitHub App, which this build does not have configured yet. Until then, use your GitHub CLI login, a token or your own app below.
        </p>
      )}
    </section>
  );
}

interface Repo {
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  updatedAt: string;
  via: 'app' | 'user';
}

/** GitHub's manifest flow: a form POST to github.com that creates the app and redirects back. */
function postManifest(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

function useGitHubStatus() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await get<GitHubStatus>('/api/github/status'));
    } catch (e) {
      setStatus({ connected: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { status, loading, load };
}

/** Settings → GitHub. */
export function GitHubSettings() {
  const { status, loading, load } = useGitHubStatus();
  const { config } = useConfig();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [org, setOrg] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  useEffect(() => setPublicUrl(String(cfgGet('gateway.publicUrl', config) ?? '')), [config]);
  const bot = (cfgGet('github.bot', config) ?? {}) as { enabled?: boolean; trigger?: string };

  const connectToken = async () => {
    setBusy(true);
    try {
      const r = await post<{ login: string }>('/api/github/token', { token });
      toast(`Connected to GitHub as ${r.login}`, 'ok');
      setToken('');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const createApp = async () => {
    setBusy(true);
    try {
      const r = await post<{ action: string; manifest: Record<string, unknown> }>('/api/github/app/manifest', { baseUrl: window.location.origin, publicUrl: publicUrl.trim(), org: org.trim(), public: isPublic });
      postManifest(r.action, r.manifest);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="gh-settings">
      <ConnectGitHub status={status} onChanged={load} />
      <p className="set-desc gh-intro">
        Advanced: run Kronos as <b>your own bot</b> (a GitHub App only you control — it also answers <code>{bot.trigger || '@kronos'}</code> in issues and pull requests when your gateway is reachable),
        or connect with a personal token.
      </p>

      <section className="gh-card">
        <header>
          <Bot size={16} />
          <b>Your own GitHub App (bot)</b>
          {status?.app ? <Badge tone="ok">Set up</Badge> : <Badge>Not set up</Badge>}
          <span className="flex-1" />
          <button className="icon-btn" title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </header>
        {status?.app ? (
          <>
            <div className="gh-row">
              <a href={status.app.htmlUrl} target="_blank" rel="noreferrer">
                {status.app.name} <ExternalLink size={12} />
              </a>
              <span className="gh-dim">acts as {status.app.slug}[bot]</span>
            </div>
            <div className="gh-row">
              {status.app.installations.length ? (
                <span>
                  Installed on {status.app.installations.map((i) => `${i.account} (${i.repositories === 'all' ? 'all repositories' : 'selected repositories'})`).join(', ')}
                </span>
              ) : (
                <span className="gh-dim">Not installed on any repository yet.</span>
              )}
            </div>
            <div className="gh-row">
              <img src="./github-app-logo.png" alt="" width={28} height={28} className="gh-logo" />
              <span className="gh-dim">
                Give the bot the Kronos logo: <a href="./github-app-logo.png" download="kronos-github-app.png">download it</a>, then upload it under <b>Display information</b> in the{' '}
                <a href={status.app.settingsUrl} target="_blank" rel="noreferrer">
                  app settings <ExternalLink size={11} />
                </a>{' '}
                (GitHub only accepts logos uploaded there).
              </span>
            </div>
            <div className="gh-row">
              <span className="gh-dim">
                @mentions: {status.app.webhook ? 'webhook active' : 'no webhook — set a public URL for this gateway, then recreate the app to answer @mentions'}
              </span>
            </div>
            <div className="gh-actions">
              <a className="btn primary" href={status.app.installUrl} target="_blank" rel="noreferrer">
                {status.app.installations.length ? 'Choose repositories' : 'Install on repositories'}
              </a>
              <button
                className="btn"
                onClick={async () => {
                  if (!confirm('Forget the Kronos GitHub App on this computer? (Delete it on GitHub too if you no longer need it.)')) return;
                  await del('/api/github/app');
                  await load();
                }}
              >
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="set-desc">
              One click creates a private GitHub App for you (you can rename it on the next page). Kronos then works as its own bot account with access only to the repositories you install it on.
            </p>
            <label className="gh-field">
              <span>Public URL of this gateway (optional, needed for @mentions)</span>
              <input className="input" placeholder="https://kronos.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
            </label>
            <label className="gh-field">
              <span>Organization (optional — leave empty for your personal account)</span>
              <input className="input" placeholder="my-org" value={org} onChange={(e) => setOrg(e.target.value)} />
            </label>
            <label className="gh-check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Public — anyone can install it (for publishing an official Kronos bot)
            </label>
            <div className="gh-actions">
              <button className="btn primary" onClick={() => void createApp()} disabled={busy}>
                <Github size={14} /> Create the GitHub App
              </button>
            </div>
          </>
        )}
      </section>

      <section className="gh-card">
        <header>
          <Github size={16} />
          <b>Personal token or GitHub CLI</b>
          {status?.user ? <Badge tone="ok">Connected</Badge> : <Badge>Not connected</Badge>}
        </header>
        {status?.user ? (
          <div className="gh-row gh-user">
            {status.user.avatarUrl && <img src={status.user.avatarUrl} alt="" width={28} height={28} />}
            <span>
              <b>{status.user.login}</b>
              {status.user.name ? ` · ${status.user.name}` : ''} <span className="gh-dim">via {status.user.source === 'gh' ? 'the GitHub CLI' : status.user.source === 'kronos' ? 'Connect GitHub' : 'a personal access token'}</span>
            </span>
            <span className="flex-1" />
            {status.user.source === 'token' && (
              <button
                className="btn"
                onClick={async () => {
                  await del('/api/github/token');
                  await load();
                }}
              >
                Disconnect
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="set-desc">
              Paste a personal access token (fine-grained, with Contents, Pull requests and Issues read/write) — or log in with <code>gh auth login</code> on this computer and Kronos uses that.
            </p>
            <div className="gh-actions">
              <input className="input" type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && token && void connectToken()} />
              <button className="btn primary" onClick={() => void connectToken()} disabled={!token || busy}>
                Connect
              </button>
              <a className="btn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                Create a token <ExternalLink size={12} />
              </a>
            </div>
          </>
        )}
      </section>

      <section className="gh-card">
        <header>
          <Bot size={16} />
          <b>Answering @mentions</b>
        </header>
        <div className="gh-row">
          <span className="flex-1">When someone with write access mentions Kronos in an issue or pull request, it works on the request and replies — with a pull request when it changed code.</span>
          <Toggle checked={bot.enabled !== false} onChange={(v) => void updateConfig({ github: { bot: { enabled: v } } })} />
        </div>
        <label className="gh-field">
          <span>Trigger</span>
          <input className="input" defaultValue={bot.trigger || '@kronos'} onBlur={(e) => e.target.value.trim() && void updateConfig({ github: { bot: { trigger: e.target.value.trim() } } })} />
        </label>
      </section>
      {status?.error && <p className="set-desc gh-error">{status.error}</p>}
    </div>
  );
}

/** "Open a GitHub repository": pick a repository, clone it and start a chat in it. */
export function RepoPicker() {
  const open = useStore((s) => s.repoPicker);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [cloning, setCloning] = useState('');

  useEffect(() => {
    if (!open) return;
    setRepos(null);
    setError('');
    get<Repo[]>('/api/github/repos')
      .then(setRepos)
      .catch((e: Error) => setError(e.message));
  }, [open]);

  const close = () => setState({ repoPicker: false });
  const clone = async (repo: string) => {
    setCloning(repo);
    try {
      const r = await post<{ path: string; updated: boolean; session: { id: string } }>('/api/github/clone', { repo });
      toast(`${r.updated ? 'Updated' : 'Cloned'} ${repo}`, 'ok');
      refreshSessions();
      openSession(r.session.id);
      void loadSession(r.session.id);
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setCloning('');
    }
  };

  const shown = (repos ?? []).filter((r) => !q.trim() || r.fullName.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open={open} onClose={close} className="repo-picker">
      <h3 className="modal-title">
        <FolderGit2 size={16} /> Open a GitHub repository
      </h3>
      {repos && !repos.length && !error ? (
        <div className="repo-empty">
          <p>No repositories yet — connect GitHub first.</p>
          <button className="btn primary" onClick={() => setState({ repoPicker: false, settings: 'github' })}>
            <Github size={14} /> Connect GitHub
          </button>
        </div>
      ) : (
        <>
          <div className="settings-search repo-search">
            <Search size={14} />
            <input placeholder="Search repositories" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          {error && (
            <div className="repo-empty">
              <p>{error}</p>
              <button className="btn primary" onClick={() => setState({ repoPicker: false, settings: 'github' })}>
                <Github size={14} /> Connect GitHub
              </button>
            </div>
          )}
          {!repos && !error && <div className="repo-empty gh-dim">Loading repositories…</div>}
          <div className="repo-list">
            {shown.map((r) => (
              <button key={r.fullName} className="repo-item" onClick={() => void clone(r.fullName)} disabled={Boolean(cloning)}>
                <span className="repo-name">
                  {r.private && <Lock size={12} />} {r.fullName}
                  {r.via === 'app' && <Badge>app</Badge>}
                </span>
                <span className="repo-desc">{cloning === r.fullName ? 'Cloning…' : r.description || r.defaultBranch}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
