import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Kronos, MemoryTarget } from '@kronos/core';

export interface ImportReport {
  source: string;
  items: string[];
  skipped: string[];
}

function copyDirChildren(src: string, dest: string, report: ImportReport, label: string, dryRun: boolean): void {
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (existsSync(to)) {
      report.skipped.push(`${label} ${name} (already exists)`);
      continue;
    }
    if (!dryRun) {
      mkdirSync(dest, { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    report.items.push(`${label} ${name}`);
  }
}

function importMemoryFile(rt: Kronos, file: string, target: MemoryTarget, report: ImportReport, dryRun: boolean): void {
  if (!existsSync(file)) return;
  const entries = readFileSync(file, 'utf8')
    .split(/\n§\n|\n-{3,}\n/)
    .map((e) => e.replace(/^#.*$/gm, '').trim())
    .filter(Boolean);
  for (const e of entries) {
    if (dryRun) {
      report.items.push(`${target} memory: ${e.slice(0, 60)}`);
      continue;
    }
    const r = rt.memory.add(target, e);
    if (r.ok) report.items.push(`${target} memory: ${e.slice(0, 60)}`);
    else report.skipped.push(`${target} memory (full): ${e.slice(0, 40)}`);
  }
}

function appendGlobalInstructions(rt: Kronos, file: string, label: string, report: ImportReport, dryRun: boolean): void {
  if (!existsSync(file) || !statSync(file).isFile()) return;
  const dest = join(rt.home, 'KRONOS.md');
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return;
  if (!dryRun) {
    const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
    if (!prev.includes(text.slice(0, 200))) writeFileSync(dest, `${prev}${prev ? '\n\n' : ''}<!-- imported from ${label} -->\n${text}\n`);
  }
  report.items.push(`global instructions from ${file}`);
}

/** Bring settings, persona, memories, skills, agents and commands over from other agents. */
export function importFrom(rt: Kronos, source: string, dryRun = false): ImportReport {
  const home = homedir();
  const report: ImportReport = { source, items: [], skipped: [] };
  const soulDest = rt.paths.soul;
  const takeSoul = (file: string) => {
    if (existsSync(file) && !existsSync(soulDest)) {
      if (!dryRun) cpSync(file, soulDest);
      report.items.push('persona SOUL.md');
    }
  };
  switch (source) {
    case 'hermes': {
      const root = process.env.HERMES_HOME ?? join(home, '.hermes');
      if (!existsSync(root)) throw new Error(`Hermes home not found at ${root}`);
      takeSoul(join(root, 'SOUL.md'));
      importMemoryFile(rt, join(root, 'memories', 'MEMORY.md'), 'memory', report, dryRun);
      importMemoryFile(rt, join(root, 'memories', 'USER.md'), 'user', report, dryRun);
      copyDirChildren(join(root, 'skills'), join(rt.paths.skills, 'hermes-imports'), report, 'skill', dryRun);
      break;
    }
    case 'openclaw': {
      const root = process.env.OPENCLAW_HOME ?? join(home, '.openclaw');
      if (!existsSync(root)) throw new Error(`OpenClaw home not found at ${root}`);
      for (const dir of [root, join(root, 'workspace')]) {
        takeSoul(join(dir, 'SOUL.md'));
        importMemoryFile(rt, join(dir, 'MEMORY.md'), 'memory', report, dryRun);
        importMemoryFile(rt, join(dir, 'USER.md'), 'user', report, dryRun);
        appendGlobalInstructions(rt, join(dir, 'AGENTS.md'), 'OpenClaw', report, dryRun);
        copyDirChildren(join(dir, 'skills'), join(rt.paths.skills, 'openclaw-imports'), report, 'skill', dryRun);
      }
      break;
    }
    case 'claude':
    case 'claude-code': {
      const root = join(home, '.claude');
      if (!existsSync(root)) throw new Error(`Claude Code config not found at ${root}`);
      appendGlobalInstructions(rt, join(root, 'CLAUDE.md'), 'Claude Code', report, dryRun);
      copyDirChildren(join(root, 'skills'), join(rt.paths.skills, 'claude-imports'), report, 'skill', dryRun);
      copyDirChildren(join(root, 'agents'), rt.paths.agents, report, 'agent', dryRun);
      copyDirChildren(join(root, 'commands'), rt.paths.commands, report, 'command', dryRun);
      break;
    }
    case 'codex': {
      const root = process.env.CODEX_HOME ?? join(home, '.codex');
      if (!existsSync(root)) throw new Error(`Codex home not found at ${root}`);
      appendGlobalInstructions(rt, join(root, 'AGENTS.md'), 'Codex', report, dryRun);
      copyDirChildren(join(root, 'prompts'), rt.paths.commands, report, 'command', dryRun);
      copyDirChildren(join(root, 'skills'), join(rt.paths.skills, 'codex-imports'), report, 'skill', dryRun);
      break;
    }
    case 'cursor': {
      const root = join(home, '.cursor');
      if (!existsSync(root)) throw new Error(`Cursor config not found at ${root}`);
      copyDirChildren(join(root, 'rules'), join(rt.home, 'imported-cursor-rules'), report, 'rule', dryRun);
      break;
    }
    default:
      throw new Error(`unknown source "${source}" (hermes, openclaw, claude, codex, cursor)`);
  }
  if (!dryRun) rt.skills.reload();
  return report;
}
