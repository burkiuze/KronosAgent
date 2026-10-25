import { useState } from 'react';
import { CircleHelp, ShieldAlert, TriangleAlert, Users, LoaderCircle, Check, CircleX } from 'lucide-react';
import type { ClarifyRequest, PermissionRequest } from '../lib/types';
import { answerClarify, answerPermission, type SubagentLive } from '../lib/store';
import { t } from '../lib/i18n';
import { Markdown } from './Message';

function InputPreview({ req }: { req: PermissionRequest }) {
  const i = req.input;
  if (req.toolName === 'shell') return <pre className="perm-cmd">$ {String(i.command ?? '')}</pre>;
  if (req.toolName === 'write_file')
    return (
      <pre className="perm-pre">
        {String(i.path)}
        {'\n\n'}
        {String(i.content ?? '').slice(0, 1500)}
      </pre>
    );
  if (req.toolName === 'edit_file')
    return (
      <pre className="perm-pre diff">
        <div className="hunk">{String(i.path)}</div>
        {String(i.old_string ?? '')
          .split('\n')
          .slice(0, 20)
          .map((l, k) => (
            <div key={`o${k}`} className="del">
              -{l}
            </div>
          ))}
        {String(i.new_string ?? '')
          .split('\n')
          .slice(0, 20)
          .map((l, k) => (
            <div key={`n${k}`} className="add">
              +{l}
            </div>
          ))}
      </pre>
    );
  if (req.toolName === 'apply_patch') return <pre className="perm-pre">{String(i.patch ?? '').slice(0, 2500)}</pre>;
  return <pre className="perm-pre">{JSON.stringify(i, null, 2).slice(0, 2000)}</pre>;
}

export function PermissionCard({ req }: { req: PermissionRequest }) {
  const [feedback, setFeedback] = useState('');
  const isPlan = req.toolName === 'exit_plan_mode';
  return (
    <div className={`perm-card ${req.dangerous ? 'dangerous' : ''}`}>
      <div className="perm-head">
        {req.dangerous ? <TriangleAlert size={16} /> : <ShieldAlert size={16} />}
        <strong>{isPlan ? t('chat.plan') : t('chat.approval')}</strong>
        {req.dangerous && <span className="badge error">dangerous</span>}
        <span className="muted perm-reason">{req.reason}</span>
      </div>
      <div className="perm-summary">{req.summary}</div>
      {isPlan ? (
        <div className="perm-plan">
          <Markdown text={String(req.input.plan ?? '')} />
        </div>
      ) : (
        <InputPreview req={req} />
      )}
      <input className="perm-feedback" placeholder={t('chat.feedback')} value={feedback} onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answerPermission(req, feedback ? 'deny' : 'allow', feedback || undefined)} />
      <div className="perm-actions">
        <button className="btn primary" onClick={() => answerPermission(req, 'allow')}>
          {isPlan ? 'Approve plan' : t('chat.allow')}
        </button>
        {!isPlan && (
          <>
            <button className="btn" onClick={() => answerPermission(req, 'allow_session')}>
              {t('chat.allowSession')}
            </button>
            {!req.dangerous && (
              <button className="btn" onClick={() => answerPermission(req, 'allow_always')}>
                {t('chat.allowAlways')}
              </button>
            )}
          </>
        )}
        <div className="flex-1" />
        <button className="btn danger-outline" onClick={() => answerPermission(req, 'deny', feedback || undefined)}>
          {isPlan ? 'Keep planning' : t('chat.deny')}
        </button>
      </div>
    </div>
  );
}

export function ClarifyCard({ req }: { req: ClarifyRequest }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="perm-card clarify">
      <div className="perm-head">
        <CircleHelp size={16} />
        <strong>{t('chat.question')}</strong>
      </div>
      <div className="perm-summary">{req.question}</div>
      {req.options && req.options.length > 0 && (
        <div className="clarify-options">
          {req.options.map((o) => (
            <button key={o} className="btn" onClick={() => answerClarify(req, o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="clarify-input">
        <input autoFocus placeholder={t('chat.answer')} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && answerClarify(req, answer.trim())} />
        <button className="btn primary" disabled={!answer.trim()} onClick={() => answerClarify(req, answer.trim())}>
          {t('chat.send')}
        </button>
      </div>
    </div>
  );
}

export function SubagentPanel({ agents }: { agents: SubagentLive[] }) {
  if (!agents.length) return null;
  return (
    <div className="subagents">
      <div className="subagents-head">
        <Users size={13} /> Subagents
      </div>
      {agents.map((a) => (
        <div key={a.agentId} className={`subagent ${a.status}`}>
          {a.status === 'done' ? <Check size={12} /> : a.status === 'error' ? <CircleX size={12} /> : <LoaderCircle size={12} className="spin" />}
          <strong>{a.label}</strong>
          <span className="muted">{a.detail}</span>
        </div>
      ))}
    </div>
  );
}
