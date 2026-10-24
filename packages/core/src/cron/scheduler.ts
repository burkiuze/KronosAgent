import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from '../types.js';
import { nextCronTime, parseSchedule, describeCron } from '../util/cron-expr.js';
import { newId, errorMessage } from '../util/misc.js';
import { truncate } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('cron');

export interface CronDelivery {
  /** platform:chatId, e.g. "telegram:12345"; "session" keeps it in Kronos only */
  target?: string;
  /** deliver only when the output is non-empty / notable */
  onlyIfNotable?: boolean;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  kind: 'cron' | 'interval' | 'once';
  cron?: string;
  intervalMs?: number;
  at?: number;
  prompt: string;
  model?: string;
  skills?: string[];
  mode?: PermissionMode;
  cwd?: string;
  deliver?: CronDelivery;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'running';
  lastOutput?: string;
  lastSessionId?: string;
  runCount: number;
  description: string;
}

export interface CronRunRecord {
  jobId: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  status: 'ok' | 'error';
  output: string;
  sessionId?: string;
}

export type CronExecutor = (job: CronJob) => Promise<{ text: string; sessionId?: string }>;

export class CronScheduler {
  private jobs: CronJob[] = [];
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  private file: string;
  private runsFile: string;
  private listeners = new Set<(e: { type: 'updated' | 'run_start' | 'run_end'; job: CronJob }) => void>();

  constructor(dir: string, private executor: CronExecutor, private opts: { timezone?: string; maxConcurrent: number }) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'jobs.json');
    this.runsFile = join(dir, 'runs.jsonl');
    this.load();
  }

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  configure(opts: { timezone?: string; maxConcurrent: number }): void {
    this.opts = opts;
    for (const j of this.jobs) j.nextRunAt = this.computeNext(j);
    this.save();
  }

  on(fn: (e: { type: 'updated' | 'run_start' | 'run_end'; job: CronJob }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: 'updated' | 'run_start' | 'run_end', job: CronJob): void {
    for (const fn of this.listeners) fn({ type, job });
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.jobs = JSON.parse(readFileSync(this.file, 'utf8')) as CronJob[];
      for (const j of this.jobs) if (j.lastStatus === 'running') j.lastStatus = 'error';
    } catch (e) {
      log.error('could not read cron jobs', e);
    }
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.jobs, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  private computeNext(job: CronJob, from = Date.now()): number | undefined {
    if (!job.enabled) return undefined;
    if (job.kind === 'once') return job.at && (!job.lastRunAt || job.lastRunAt < job.at) ? job.at : undefined;
    if (job.kind === 'interval') return (job.lastRunAt ?? job.createdAt) + (job.intervalMs ?? 3600_000);
    if (job.cron) return nextCronTime(job.cron, from, this.opts.timezone || undefined) ?? undefined;
    return undefined;
  }

  list(): CronJob[] {
    return [...this.jobs].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  }

  get(idOrName: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === idOrName) ?? this.jobs.find((j) => j.name.toLowerCase() === idOrName.toLowerCase());
  }

  create(input: { name?: string; schedule: string; prompt: string; model?: string; skills?: string[]; mode?: PermissionMode; cwd?: string; deliver?: CronDelivery; enabled?: boolean }): CronJob {
    const parsed = parseSchedule(input.schedule);
    const now = Date.now();
    const job: CronJob = {
      id: newId('c_'),
      name: input.name?.trim() || truncate(input.prompt.replace(/\s+/g, ' '), 48),
      schedule: input.schedule,
      kind: parsed.kind,
      cron: parsed.cron,
      intervalMs: parsed.intervalMs,
      at: parsed.at,
      prompt: input.prompt,
      model: input.model,
      skills: input.skills,
      mode: input.mode,
      cwd: input.cwd,
      deliver: input.deliver,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      description: parsed.cron ? describeCron(parsed.cron) : parsed.description,
    };
    job.nextRunAt = this.computeNext(job);
    this.jobs.push(job);
    this.save();
    this.emit('updated', job);
    return job;
  }

  update(id: string, patch: Partial<Pick<CronJob, 'name' | 'prompt' | 'model' | 'enabled' | 'deliver' | 'mode' | 'skills' | 'cwd'>> & { schedule?: string }): CronJob {
    const job = this.get(id);
    if (!job) throw new Error(`no cron job ${id}`);
    if (patch.schedule) {
      const parsed = parseSchedule(patch.schedule);
      Object.assign(job, { schedule: patch.schedule, kind: parsed.kind, cron: parsed.cron, intervalMs: parsed.intervalMs, at: parsed.at, description: parsed.cron ? describeCron(parsed.cron) : parsed.description });
    }
    const { schedule: _s, ...rest } = patch;
    Object.assign(job, rest, { updatedAt: Date.now() });
    job.nextRunAt = this.computeNext(job);
    this.save();
    this.emit('updated', job);
    return job;
  }

  remove(id: string): boolean {
    const n = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id && j.name !== id);
    this.save();
    return this.jobs.length !== n;
  }

  history(jobId?: string, limit = 50): CronRunRecord[] {
    if (!existsSync(this.runsFile)) return [];
    return readFileSync(this.runsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CronRunRecord)
      .filter((r) => !jobId || r.jobId === jobId)
      .slice(-limit)
      .reverse();
  }

  start(): void {
    if (this.timer) return;
    for (const j of this.jobs) j.nextRunAt = this.computeNext(j);
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = Date.now()): Promise<void> {
    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue;
      if (this.running.has(job.id) || this.running.size >= this.opts.maxConcurrent) continue;
      void this.run(job.id);
    }
  }

  async run(id: string): Promise<CronRunRecord> {
    const job = this.get(id);
    if (!job) throw new Error(`no cron job ${id}`);
    if (this.running.has(job.id)) throw new Error('job is already running');
    this.running.add(job.id);
    const startedAt = Date.now();
    job.lastStatus = 'running';
    job.lastRunAt = startedAt;
    job.nextRunAt = this.computeNext(job, startedAt + 1000);
    this.save();
    this.emit('run_start', job);
    let record: CronRunRecord;
    try {
      const res = await this.executor(job);
      record = { jobId: job.id, name: job.name, startedAt, finishedAt: Date.now(), status: 'ok', output: truncate(res.text, 20_000), sessionId: res.sessionId };
      job.lastStatus = 'ok';
      job.lastOutput = truncate(res.text, 2000);
      job.lastSessionId = res.sessionId;
    } catch (e) {
      record = { jobId: job.id, name: job.name, startedAt, finishedAt: Date.now(), status: 'error', output: errorMessage(e) };
      job.lastStatus = 'error';
      job.lastOutput = errorMessage(e);
      log.error(`cron job ${job.name} failed`, e);
    } finally {
      this.running.delete(job.id);
    }
    job.runCount += 1;
    if (job.kind === 'once') job.enabled = false;
    job.nextRunAt = this.computeNext(job);
    this.save();
    appendFileSync(this.runsFile, `${JSON.stringify(record)}\n`);
    this.emit('run_end', job);
    return record;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }
}
