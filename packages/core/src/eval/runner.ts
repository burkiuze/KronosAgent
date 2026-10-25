import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import type { EffortSetting, Message, PermissionMode } from '../types.js';
import type { Kronos } from '../runtime.js';
import { runShell } from '../util/process.js';

/**
 * Evaluation harness. An agent is a configured system — model, effort, tools, the information it
 * is given — and the same configuration varies a lot from run to run. So every case runs several
 * times per configuration, results report the spread next to the mean, and cost, tokens, time
 * and tool calls are reported alongside the pass rate.
 */

export interface EvalCheck {
  /** final answer contains this text (case-insensitive) */
  contains?: string;
  not_contains?: string;
  /** final answer matches this regular expression */
  regex?: string;
  /** file exists in the workspace afterwards */
  file?: string;
  file_contains?: { path: string; text: string };
  /** shell command run in the workspace must exit 0 */
  command?: string;
  max_tool_calls?: number;
}

export interface EvalCase {
  name: string;
  prompt: string;
  /** files created in a fresh workspace before the run */
  files?: Record<string, string>;
  checks: EvalCheck[];
  mode?: PermissionMode;
}

export interface EvalSuite {
  name: string;
  repeats: number;
  matrix: { model: string[]; effort: EffortSetting[] };
  timeoutSec: number;
  cases: EvalCase[];
}

export interface EvalConfig {
  id: string;
  model: string;
  effort: EffortSetting;
}

export interface EvalRunRecord {
  config: string;
  case: string;
  repeat: number;
  passed: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
  tokens: number;
  costUsd: number;
  durationMs: number;
  toolCalls: number;
  error?: string;
}

export interface EvalConfigSummary {
  config: string;
  model: string;
  effort: EffortSetting;
  runs: number;
  /** mean pass rate over all runs (0..1) */
  passRate: number;
  /** standard deviation of the suite pass rate across repeats — the run-to-run noise */
  stdev: number;
  perCase: Record<string, { passed: number; runs: number }>;
  meanTokens: number;
  meanCostUsd: number;
  totalCostUsd: number;
  meanDurationMs: number;
  meanToolCalls: number;
}

const EFFORTS: EffortSetting[] = ['low', 'medium', 'high', 'xhigh', 'max', 'codemaster'];

/** Parse and validate a suite file (YAML or JSON). */
export function parseEvalSuite(text: string, fallbackName = 'suite'): EvalSuite {
  const raw = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  const asList = <T>(v: unknown): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);
  const matrix = (raw.matrix ?? {}) as Record<string, unknown>;
  const efforts = asList<string>(matrix.effort ?? raw.effort);
  for (const e of efforts) if (!EFFORTS.includes(e as EffortSetting)) throw new Error(`unknown effort "${e}" (use ${EFFORTS.join(', ')})`);
  const cases = asList<Record<string, unknown>>(raw.cases).map((c, i) => {
    const name = String(c.name ?? `case ${i + 1}`);
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new Error(`case "${name}" needs a prompt`);
    const checks = asList<EvalCheck>(c.checks ?? c.expect);
    if (!checks.length) throw new Error(`case "${name}" needs at least one check`);
    for (const check of checks) {
      const keys = Object.keys(check);
      if (!keys.length || keys.some((k) => !['contains', 'not_contains', 'regex', 'file', 'file_contains', 'command', 'max_tool_calls'].includes(k)))
        throw new Error(`case "${name}": unknown check ${JSON.stringify(check)}`);
    }
    return { name, prompt: c.prompt, files: (c.files as Record<string, string>) ?? undefined, checks, mode: (c.mode as PermissionMode) ?? undefined };
  });
  if (!cases.length) throw new Error('the suite has no cases');
  return {
    name: String(raw.name ?? fallbackName),
    repeats: Math.max(1, Math.min(50, Number(raw.repeats ?? 3))),
    matrix: { model: asList<string>(matrix.model ?? raw.model), effort: efforts as EffortSetting[] },
    timeoutSec: Math.max(10, Number(raw.timeoutSec ?? raw.timeout ?? 900)),
    cases,
  };
}

/** Every model × effort combination; empty axes fall back to the base configuration. */
export function evalConfigs(suite: EvalSuite, base: { model: string; effort: EffortSetting }): EvalConfig[] {
  const models = suite.matrix.model.length ? suite.matrix.model : [base.model];
  const efforts = suite.matrix.effort.length ? suite.matrix.effort : [base.effort];
  return models.flatMap((model) => efforts.map((effort) => ({ id: `${model} · ${effort}`, model, effort })));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = resolve(root, rel);
    if (!target.startsWith(root + sep)) throw new Error(`fixture path escapes the workspace: ${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

async function runChecks(checks: EvalCheck[], ws: string, text: string, toolCalls: number): Promise<{ label: string; ok: boolean; detail?: string }[]> {
  const out: { label: string; ok: boolean; detail?: string }[] = [];
  const lower = text.toLowerCase();
  for (const c of checks) {
    if (c.contains !== undefined) out.push({ label: `contains "${c.contains}"`, ok: lower.includes(c.contains.toLowerCase()) });
    if (c.not_contains !== undefined) out.push({ label: `does not contain "${c.not_contains}"`, ok: !lower.includes(c.not_contains.toLowerCase()) });
    if (c.regex !== undefined) out.push({ label: `matches /${c.regex}/`, ok: new RegExp(c.regex, 'i').test(text) });
    if (c.file !== undefined) out.push({ label: `file ${c.file} exists`, ok: existsSync(resolve(ws, c.file)) });
    if (c.file_contains) {
      const p = resolve(ws, c.file_contains.path);
      const ok = existsSync(p) && readFileSync(p, 'utf8').includes(c.file_contains.text);
      out.push({ label: `${c.file_contains.path} contains "${c.file_contains.text}"`, ok });
    }
    if (c.command !== undefined) {
      const r = await runShell(c.command, { cwd: ws, timeoutMs: 300_000 });
      out.push({ label: `\`${c.command}\` passes`, ok: r.exitCode === 0, detail: r.exitCode === 0 ? undefined : r.output.trim().split('\n').slice(-5).join('\n') });
    }
    if (c.max_tool_calls !== undefined) out.push({ label: `≤ ${c.max_tool_calls} tool calls`, ok: toolCalls <= c.max_tool_calls, detail: `${toolCalls} calls` });
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function summarizeEval(configs: EvalConfig[], runs: EvalRunRecord[]): EvalConfigSummary[] {
  return configs.map((cfg) => {
    const mine = runs.filter((r) => r.config === cfg.id);
    const perCase: Record<string, { passed: number; runs: number }> = {};
    for (const r of mine) {
      const pc = (perCase[r.case] ??= { passed: 0, runs: 0 });
      pc.runs++;
      if (r.passed) pc.passed++;
    }
    const repeats = [...new Set(mine.map((r) => r.repeat))];
    const perRepeat = repeats.map((k) => mean(mine.filter((r) => r.repeat === k).map((r) => (r.passed ? 1 : 0))));
    return {
      config: cfg.id,
      model: cfg.model,
      effort: cfg.effort,
      runs: mine.length,
      passRate: mean(mine.map((r) => (r.passed ? 1 : 0))),
      stdev: stdev(perRepeat),
      perCase,
      meanTokens: mean(mine.map((r) => r.tokens)),
      meanCostUsd: mean(mine.map((r) => r.costUsd)),
      totalCostUsd: mine.reduce((a, r) => a + r.costUsd, 0),
      meanDurationMs: mean(mine.map((r) => r.durationMs)),
      meanToolCalls: mean(mine.map((r) => r.toolCalls)),
    };
  });
}

export interface RunEvalOptions {
  /** a fresh, isolated runtime for one run (its own home, so memory and skills cannot leak between runs) */
  createRuntime: (cfg: EvalConfig, home: string) => Promise<Kronos>;
  repeats?: number;
  onRun?: (record: EvalRunRecord, progress: { done: number; total: number }) => void;
  /** receives each run's full trajectory (every message and tool call) before its runtime is discarded */
  onTrajectory?: (record: EvalRunRecord, messages: Message[]) => void;
  signal?: AbortSignal;
}

export async function runEvalSuite(suite: EvalSuite, configs: EvalConfig[], opts: RunEvalOptions): Promise<{ runs: EvalRunRecord[]; summary: EvalConfigSummary[] }> {
  const repeats = opts.repeats ?? suite.repeats;
  const total = configs.length * suite.cases.length * repeats;
  const runs: EvalRunRecord[] = [];
  // repeat-major order spreads each configuration over the whole session, so drift in a
  // provider's latency or load does not land on one configuration only
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const cfg of configs) {
      for (const c of suite.cases) {
        if (opts.signal?.aborted) return { runs, summary: summarizeEval(configs, runs) };
        const root = mkdtempSync(join(tmpdir(), 'kronos-eval-'));
        const home = join(root, 'home');
        const ws = join(root, 'workspace');
        mkdirSync(ws, { recursive: true });
        let record: EvalRunRecord;
        let rt: Kronos | undefined;
        let trajectory: Message[] = [];
        try {
          if (c.files) writeFiles(ws, c.files);
          rt = await opts.createRuntime(cfg, home);
          const timeout = AbortSignal.timeout(suite.timeoutSec * 1000);
          const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
          const res = await rt.runHeadless(c.prompt, { source: 'eval', cwd: ws, mode: c.mode ?? 'yolo', autoApprove: true, model: cfg.model, signal });
          if (opts.onTrajectory) trajectory = rt.sessions.messages(res.sessionId);
          const checks = await runChecks(c.checks, ws, res.text, res.toolCalls);
          const tokens = res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
          record = {
            config: cfg.id,
            case: c.name,
            repeat,
            passed: !res.error && res.stopReason !== 'interrupted' && checks.every((x) => x.ok),
            checks,
            tokens,
            costUsd: res.usage.costUsd ?? 0,
            durationMs: res.durationMs,
            toolCalls: res.toolCalls,
            error: res.error ?? (res.stopReason === 'interrupted' ? `timed out after ${suite.timeoutSec}s` : undefined),
          };
        } catch (e) {
          record = { config: cfg.id, case: c.name, repeat, passed: false, checks: [], tokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0, error: (e as Error).message };
        } finally {
          await rt?.close().catch(() => undefined);
          rmSync(root, { recursive: true, force: true });
        }
        runs.push(record);
        if (opts.onTrajectory) opts.onTrajectory(record, trajectory);
        opts.onRun?.(record, { done: runs.length, total });
      }
    }
  }
  return { runs, summary: summarizeEval(configs, runs) };
}
