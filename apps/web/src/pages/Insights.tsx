import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartColumn } from 'lucide-react';
import { get } from '../lib/api';
import { cost, tokens } from '../lib/format';
import { Tabs } from '../components/ui';

interface Row {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
  toolCalls: number;
}

interface Usage {
  days: number;
  total: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; requests: number; toolCalls: number };
  byDay: Row[];
  byModel: Row[];
  bySource: Row[];
  sessions: number;
  subagents: number;
  skills: { name: string; uses: number; lastUsed: number }[];
  memory: { memory: { chars: number; limit: number }; user: { chars: number; limit: number } };
}

/** Single-series daily bar chart (magnitude → one hue), hover tooltip per bar. */
function DailyBars({ rows, days }: { rows: Row[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const map = new Map(rows.map((r) => [r.key, r]));
    const out: { day: string; value: number; row?: Row }[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const r = map.get(d);
      out.push({ day: d, value: r ? r.inputTokens + r.cacheReadTokens + r.outputTokens : 0, row: r });
    }
    return out;
  }, [rows, days]);
  const max = Math.max(1, ...series.map((s) => s.value));
  // draw at the real pixel width so text and marks keep their size at any panel width
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 200;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const bw = (W - pad.l - pad.r) / series.length;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const h = hover !== null ? series[hover] : undefined;
  return (
    <div className="chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per day">
        {ticks.map((tv, i) => {
          const y = pad.t + (H - pad.t - pad.b) * (1 - tv / max);
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="grid" />
              <text x={pad.l - 6} y={y + 3} className="axis" textAnchor="end">
                {tokens(Math.round(tv))}
              </text>
            </g>
          );
        })}
        {series.map((s, i) => {
          const bh = ((H - pad.t - pad.b) * s.value) / max;
          const x = pad.l + i * bw + 1;
          const y = H - pad.b - bh;
          const w = Math.max(1, bw - 2);
          return (
            <g key={s.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {s.value > 0 && <path d={`M${x},${H - pad.b} V${y + Math.min(4, bh)} Q${x},${y} ${x + Math.min(4, w / 2)},${y} H${x + w - Math.min(4, w / 2)} Q${x + w},${y} ${x + w},${y + Math.min(4, bh)} V${H - pad.b} Z`} className={`bar ${hover === i ? 'hot' : ''}`} />}
              {(i === 0 || i === series.length - 1 || i % Math.ceil(series.length / 6) === 0) && (
                <text x={pad.l + i * bw + bw / 2} y={H - 6} className="axis" textAnchor="middle">
                  {s.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="baseline" />
      </svg>
      {h && (
        <div className="chart-tip">
          <b>{h.day}</b>
          <span>{tokens(h.value)} tokens</span>
          <span>{h.row ? `${h.row.requests} requests · ${cost(h.row.costUsd)}` : 'no activity'}</span>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function InsightsPage() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    void get<Usage>(`/api/usage?days=${days}`).then(setU);
  }, [days]);
  const cacheRate = u && u.total.inputTokens + u.total.cacheReadTokens > 0 ? Math.round((u.total.cacheReadTokens / (u.total.inputTokens + u.total.cacheReadTokens)) * 100) : 0;
  return (
    <div className="page">
      <div className="page-head">
        <ChartColumn size={18} />
        <div>
          <h2>Insights</h2>
          <p className="muted">Usage, cost, cache efficiency, models and the skills Kronos relies on.</p>
        </div>
        <div className="flex-1" />
        <Tabs value={days} onChange={setDays} tabs={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }]} />
      </div>
      <div className="page-body">
        {u && (
          <>
            <div className="tiles">
              <Tile label="Cost" value={cost(u.total.costUsd)} sub={`${u.total.requests} model requests`} />
              <Tile label="Tokens" value={tokens(u.total.inputTokens + u.total.cacheReadTokens + u.total.outputTokens)} sub={`${tokens(u.total.outputTokens)} generated`} />
              <Tile label="Cache hit rate" value={`${cacheRate}%`} sub="of input tokens" />
              <Tile label="Sessions" value={String(u.sessions)} sub={`${u.subagents} subagents`} />
              <Tile label="Tool calls" value={String(u.total.toolCalls)} />
            </div>
            <h4 className="list-cat">Tokens per day</h4>
            <DailyBars rows={u.byDay} days={Number(days)} />
            <div className="grid2">
              <div>
                <h4 className="list-cat">By model</h4>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="num">Requests</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.byModel.map((r) => (
                      <tr key={r.key}>
                        <td className="mono">{r.key}</td>
                        <td className="num">{r.requests}</td>
                        <td className="num">{tokens(r.inputTokens + r.cacheReadTokens + r.outputTokens)}</td>
                        <td className="num">{cost(r.costUsd)}</td>
                      </tr>
                    ))}
                    {!u.byModel.length && (
                      <tr>
                        <td colSpan={4} className="muted">
                          No usage yet
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div>
                <h4 className="list-cat">By surface</h4>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th className="num">Requests</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.bySource.map((r) => (
                      <tr key={r.key}>
                        <td>{r.key}</td>
                        <td className="num">{r.requests}</td>
                        <td className="num">{cost(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4 className="list-cat">Most used skills</h4>
                {u.skills.length ? (
                  u.skills.map((s) => (
                    <div key={s.name} className="bar-row">
                      <span>{s.name}</span>
                      <span className="bar-track">
                        <span style={{ width: `${(s.uses / Math.max(1, u.skills[0]?.uses ?? 1)) * 100}%` }} />
                      </span>
                      <span className="num">{s.uses}</span>
                    </div>
                  ))
                ) : (
                  <div className="muted small">No skills used yet.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
