import { useEffect, useState } from 'react';
import { Crown, ExternalLink, Lock, LogOut, RefreshCw, Ticket } from 'lucide-react';
import { cancelSignIn, fmtReset, loadAccount, redeemCode, signOut, skipAccount, startSignIn, useAccount, type UsageWindow } from '../lib/account';
import { setState, toast } from '../lib/store';
import { KronosMark } from './Logo';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * First start: sign in, create an account, or go on without one. Kronos works with the person's
 * own API keys either way; an account adds Kronos Cloud models with a membership.
 */
export function Onboarding() {
  const { status, waiting, signInUrl } = useAccount();
  const [busy, setBusy] = useState(false);
  if (!status || status.onboarded) return null;
  const go = async (mode: 'sign-in' | 'sign-up') => {
    setBusy(true);
    try {
      await startSignIn(mode);
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <KronosMark size={64} busy={waiting} />
        <h1>Welcome to Kronos</h1>
        {waiting ? (
          <>
            <p className="muted">Finish signing in in your browser. This window updates by itself.</p>
            {signInUrl && (
              <a className="btn" href={signInUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open the sign-in page again
              </a>
            )}
            <button className="link-btn" onClick={cancelSignIn}>
              Back
            </button>
          </>
        ) : (
          <>
            <p className="muted">Sign in to use Kronos Cloud models with a membership, or continue and connect your own API keys.</p>
            <div className="onboarding-actions">
              <button className="btn primary" disabled={busy} onClick={() => void go('sign-in')}>
                Sign in
              </button>
              <button className="btn" disabled={busy} onClick={() => void go('sign-up')}>
                Create account
              </button>
            </div>
            <button className="link-btn" onClick={() => void skipAccount()}>
              Continue without an account
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Meter({ label, w }: { label: string; w: UsageWindow }) {
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{label}</span>
        <span className={w.percent >= 90 ? 'usage-left hot' : 'usage-left'}>{Math.max(0, Math.round(100 - w.percent))}% left</span>
      </div>
      <div className="usage-bar">
        <div className={w.percent >= 90 ? 'hot' : ''} style={{ width: `${Math.max(0, 100 - w.percent)}%` }} />
      </div>
      <div className="set-desc">
        {w.percent}% used · {fmtReset(w.resetsAt)}
      </div>
    </div>
  );
}

/**
 * Sidebar chip for members: what is left of the tighter of the two Kronos Cloud windows, so a
 * long session does not run into the limit unannounced. Refreshes every minute while shown.
 */
export function CloudUsageChip() {
  const { status } = useAccount();
  const a = status?.signedIn ? status.account : null;
  useEffect(() => {
    if (!a?.plan) return;
    const timer = setInterval(() => void loadAccount(true), 60_000);
    return () => clearInterval(timer);
  }, [a?.plan]);
  if (!a?.plan) return null;
  const tight = a.usage.fiveHour.percent >= a.usage.week.percent ? { w: a.usage.fiveHour, label: '5-hour' } : { w: a.usage.week, label: 'weekly' };
  const left = Math.max(0, Math.round(100 - tight.w.percent));
  return (
    <button
      className={`cloud-usage ${left <= 10 ? 'hot' : ''}`}
      onClick={() => setState({ settings: 'membership' })}
      title={`Kronos Cloud ${a.plan.name}: ${left}% of your ${tight.label} allowance left. ${fmtReset(tight.w.resetsAt)}`}
    >
      <span className="cloud-usage-head">
        <span>{a.plan.name}</span>
        <span>{left}% left</span>
      </span>
      <span className="usage-bar">
        <span style={{ width: `${left}%` }} />
      </span>
    </button>
  );
}

/** Settings → Membership: account, plan, usage, promo codes and the Kronos Cloud models. */
export function MembershipSettings() {
  const { status, waiting } = useAccount();
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  useEffect(() => {
    void loadAccount(true);
  }, []);
  if (!status) return <div className="muted pad">Loading…</div>;
  const a = status.account;
  const plansUrl = `${status.cloudUrl}/kronosagent#plans`;

  const redeem = async () => {
    if (!code.trim()) return;
    setRedeeming(true);
    try {
      const s = await redeemCode(code.trim());
      setCode('');
      toast(`${s.account?.plan?.name ?? 'Membership'} is active`, 'ok');
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="set-list membership">
      {status.error && <div className="notice warn">{status.error}</div>}
      {!status.signedIn ? (
        <div className="set-row">
          <div className="set-text">
            <div className="set-title">Not signed in</div>
            <div className="set-desc">Sign in to your Kronos account to use Kronos Cloud models. Kronos keeps working with your own API keys without an account.</div>
          </div>
          <div className="row gap">
            <button className="btn primary small" disabled={waiting} onClick={() => void startSignIn('sign-in').catch((e) => toast(errText(e), 'error'))}>
              {waiting ? 'Waiting for browser…' : 'Sign in'}
            </button>
            <button className="btn small" disabled={waiting} onClick={() => void startSignIn('sign-up').catch((e) => toast(errText(e), 'error'))}>
              Create account
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">{a?.email ?? 'Signed in'}</div>
              <div className="set-desc">
                {a?.plan ? (
                  <>
                    <Crown size={12} className="accent" /> {a.plan.name}
                    {a.planExpiresAt ? ` · until ${new Date(a.planExpiresAt).toLocaleDateString()}` : ''}
                  </>
                ) : (
                  'No membership — Kronos Cloud models are locked.'
                )}
              </div>
            </div>
            <div className="row gap">
              <button className="icon-btn" title="Refresh" onClick={() => void loadAccount(true)}>
                <RefreshCw size={14} />
              </button>
              <button className="btn small" onClick={() => void signOut()}>
                <LogOut size={13} /> Sign out
              </button>
            </div>
          </div>
          {a?.plan && (
            <div className="set-row usage-row">
              <Meter label="This 5-hour session" w={a.usage.fiveHour} />
              <Meter label="This week" w={a.usage.week} />
            </div>
          )}
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">
                <Ticket size={13} /> Promo code
              </div>
              <div className="set-desc">Redeem a code to start or extend a membership.</div>
            </div>
            <div className="row gap">
              <input className="mono" placeholder="PROMO-CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && void redeem()} />
              <button className="btn small primary" disabled={!code.trim() || redeeming} onClick={() => void redeem()}>
                {redeeming ? 'Redeeming…' : 'Redeem'}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="set-row column">
        <div className="set-title">Plans</div>
        <div className="plan-grid">
          {status.plans.map((p) => (
            <div key={p.id} className={`plan-card ${a?.plan?.id === p.id ? 'current' : ''}`}>
              <div className="plan-name">{p.name}</div>
              <div className="plan-mult">{p.multiplier === 1 ? 'Standard usage' : p.multiplier < 1 ? 'Lighter usage' : `${p.multiplier}× Pro usage`}</div>
              <div className="set-desc">{p.description}</div>
              {a?.plan?.id === p.id && <div className="plan-badge">Current</div>}
            </div>
          ))}
        </div>
        <a className="set-desc link" href={plansUrl} target="_blank" rel="noreferrer">
          Compare plans on heynavio.com <ExternalLink size={11} />
        </a>
      </div>

      <div className="set-row column">
        <div className="set-title">Kronos Cloud models</div>
        {status.models.map((m) => (
          <div key={m.id} className="cloud-model">
            {!a?.plan && <Lock size={12} className="muted" />}
            <span className="cloud-model-name">{m.name}</span>
            <span className="muted">{m.provider}</span>
            <span className="mono muted">cloud:{m.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
