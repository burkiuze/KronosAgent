import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './text.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let level: LogLevel = (process.env.KRONOS_LOG_LEVEL as LogLevel) || 'warn';
let file: string | undefined;
let toConsole = true;

export function configureLogger(opts: { level?: LogLevel; file?: string; console?: boolean }): void {
  if (opts.level) level = opts.level;
  if (opts.file !== undefined) {
    file = opts.file;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* ignore */
    }
  }
  if (opts.console !== undefined) toConsole = opts.console;
}

function write(lvl: LogLevel, scope: string, args: unknown[]): void {
  const text = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${redactSecrets(text)}`;
  if (file && (ORDER[lvl] >= ORDER.info || level === 'debug')) {
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* ignore */
    }
  }
  if (toConsole && ORDER[lvl] >= ORDER[level]) process.stderr.write(`${line}\n`);
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}
