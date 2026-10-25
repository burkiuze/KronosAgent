import { useEffect, useState } from 'react';
import { CalendarClock, CircleCheck, CircleX, LoaderCircle, Play, Plus, Trash2 } from 'lucide-react';
import { del, get, patch, post } from '../lib/api';
import { openSession, toast, useStore } from '../lib/store';
import { relTime } from '../lib/format';
import type { CronJob, CronRun } from '../lib/types';
import { Badge, Empty, Field, Modal, Toggle } from '../components/ui';

const EXAMPLES = [
  { name: 'Morning briefing', schedule: 'weekdays at 8:00', prompt: 'Search the web for the most important news about AI and my tech stack today and write a crisp 5-bullet briefing with links.' },
  { name: 'Repo health check', schedule: 'every day at 18:00', prompt: 'In the workspace repository, run the test suite and linters, check for outdated dependencies and summarize anything that needs attention.' },
  { name: 'Weekly review', schedule: 'every friday at 17:00', prompt: 'Summarize what we worked on this week using past conversations (session_search), list open loops and suggest priorities for next week.' },
];

function NewAutomation({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('every day at 9am');
  const [prompt, setPrompt] = useState('');
  const [deliver, setDeliver] = useState('');
  const [preview, setPreview] = useState<{ ok: boolean; description?: string; error?: string }>({ ok: true });
  useEffect(() => {
    const id = setTimeout(() => {
      void get<{ ok: boolean; description?: string; error?: string }>(`/api/cron/describe?s=${encodeURIComponent(schedule)}`).then(setPreview);
    }, 250);
    return () => clearTimeout(id);
  }, [schedule]);
  return (
    <Modal open onClose={onClose} wide>
      <h2>New automation</h2>
      <p className="muted">Kronos runs the prompt on schedule with full tool access and delivers the result. Automations run while the desktop app or `kronos gateway` is running.</p>
      <div className="examples">
        {EXAMPLES.map((e) => (
          <button key={e.name} className="chip" onClick={() => (setName(e.name), setSchedule(e.schedule), setPrompt(e.prompt))}>
            {e.name}
          </button>
        ))}
      </div>
      <div className="grid2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" />
        </Field>
        <Field label="Schedule" hint={preview.ok ? <span className="ok-text">✓ {preview.description}</span> : <span className="danger">{preview.error}</span>}>
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="weekdays at 8:00 · every 30 minutes · 0 9 * * 1" />
        </Field>
      </div>
      <Field label="What should Kronos do? (standalone instruction)">
        <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <Field label="Deliver to" hint="telegram:<chat id>, discord:<channel>, slack:<channel>, webhook:https://… or leave empty to keep it in Kronos. Use 'telegram:home' for the home chat.">
        <input value={deliver} onChange={(e) => setDeliver(e.target.value)} placeholder="telegram:home" />
      </Field>
      <div className="modal-actions">
        <div className="flex-1" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!prompt || !preview.ok}
          onClick={async () => {
            try {
              await post('/api/cron', { name, schedule, prompt, deliver: deliver || undefined });
              toast('Automation scheduled');
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          Schedule
        </button>
      </div>
    </Modal>
  );
}

export function AutomationsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useStore((s) => s.configVersion);
  const load = () =>
    void get<{ jobs: CronJob[]; history: CronRun[] }>('/api/cron').then((r) => {
      setJobs(r.jobs);
      setHistory(r.history);
    });
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <CalendarClock size={18} />
        <div>
          <h2>Automations</h2>
          <p className="muted">Scheduled, unattended agent runs — daily reports, monitoring, backups, digests. You can also just ask Kronos: “every weekday at 9 send me …”.</p>
        </div>
        <div className="flex-1" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New automation
        </button>
      </div>
      <div className="page-body">
        {jobs.length ? (
          jobs.map((j) => (
            <div key={j.id} className={`automation ${j.enabled ? '' : 'paused'}`}>
              <div className="list-row clickable" onClick={() => setOpen(open === j.id ? null : j.id)}>
                <div className="automation-icon">{j.running ? <LoaderCircle size={16} className="spin" /> : j.lastStatus === 'error' ? <CircleX size={16} className="danger" /> : j.lastStatus === 'ok' ? <CircleCheck size={16} className="ok-text" /> : <CalendarClock size={16} />}</div>
                <div className="list-main">
                  <div className="list-title">{j.name}</div>
                  <div className="list-desc">
                    {j.description}
                    {j.nextRunAt && j.enabled ? ` · next ${new Date(j.nextRunAt).toLocaleString()}` : ''}
                    {j.lastRunAt ? ` · last ${relTime(j.lastRunAt)}` : ''}
                    {j.deliver?.target ? ` · → ${j.deliver.target}` : ''}
                  </div>
                </div>
                <Badge>{j.runCount} runs</Badge>
                <button
                  className="icon-btn"
                  title="Run now"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await post(`/api/cron/${j.id}/run`);
                    toast(`Running ${j.name}`, 'info');
                    setTimeout(load, 500);
                  }}
                >
                  <Play size={14} />
                </button>
                <Toggle checked={j.enabled} onChange={async (v) => (await patch(`/api/cron/${j.id}`, { enabled: v }), load())} />
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete automation "${j.name}"?`)) {
                      await del(`/api/cron/${j.id}`);
                      load();
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {open === j.id && (
                <div className="automation-body">
                  <div className="tool-label">Prompt</div>
                  <pre className="prompt-pre">{j.prompt}</pre>
                  {j.lastOutput && (
                    <>
                      <div className="tool-label">Last output</div>
                      <pre className="prompt-pre">{j.lastOutput}</pre>
                    </>
                  )}
                  {j.lastSessionId && (
                    <button className="btn small" onClick={() => openSession(j.lastSessionId)}>
                      Open last run
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <Empty icon={<CalendarClock size={28} />} title="No automations yet">
            <button className="btn primary" onClick={() => setCreating(true)}>
              Create your first automation
            </button>
          </Empty>
        )}
        {history.length > 0 && (
          <>
            <h4 className="list-cat">Recent runs</h4>
            {history.slice(0, 15).map((r, i) => (
              <div key={i} className="list-row clickable" onClick={() => r.sessionId && openSession(r.sessionId)}>
                {r.status === 'ok' ? <CircleCheck size={14} className="ok-text" /> : <CircleX size={14} className="danger" />}
                <div className="list-main">
                  <div className="list-title">
                    {r.name} <span className="muted small">{new Date(r.startedAt).toLocaleString()}</span>
                  </div>
                  <div className="list-desc">{r.output.slice(0, 200)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {creating && <NewAutomation onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}
