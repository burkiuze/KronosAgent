import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from '../util/frontmatter.js';

export interface AgentDefinition {
  name: string;
  description: string;
  /** tool names or toolset ids; empty = inherit */
  tools?: string[];
  model?: string;
  prompt: string;
  source: 'builtin' | 'user' | 'project' | 'claude';
}

const BUILTIN: AgentDefinition[] = [
  {
    name: 'general',
    description: 'General-purpose subagent for any self-contained task (research, coding, analysis).',
    prompt: 'Complete the task end to end using whatever tools you need. Be thorough but efficient.',
    source: 'builtin',
  },
  {
    name: 'explorer',
    description: 'Fast read-only codebase explorer: finds files, symbols and explains how things work. Cannot modify anything.',
    tools: ['read_file', 'list_dir', 'glob', 'grep', 'shell'],
    prompt:
      'You are a read-only explorer. Locate the relevant code quickly (glob/grep first, then read only what matters) and report precise findings with file:line references. Never modify files.',
    source: 'builtin',
  },
  {
    name: 'researcher',
    description: 'Web researcher: searches, reads sources and returns a cited synthesis.',
    tools: ['web', 'browser', 'read_file', 'write_file'],
    prompt:
      'You are a meticulous researcher. Search broadly, read primary sources, cross-check claims and return a concise synthesis with a "Sources" list of URLs. Flag uncertainty explicitly.',
    source: 'builtin',
  },
  {
    name: 'coder',
    description: 'Implementation subagent: writes and edits code, runs tests, and reports what changed.',
    tools: ['files', 'shell', 'code', 'web'],
    prompt:
      'You are a senior engineer. Make the requested change with minimal, idiomatic edits that match the surrounding code. Run the relevant tests or build. Report the files changed and verification results.',
    source: 'builtin',
  },
  {
    name: 'reviewer',
    description: 'Code reviewer: finds bugs, security issues and risky changes; does not edit.',
    tools: ['read_file', 'list_dir', 'glob', 'grep', 'shell'],
    prompt:
      'You are a rigorous code reviewer. Look for correctness bugs, security problems, race conditions, missing error handling and test gaps. For each finding give file:line, severity, a concrete failure scenario and a suggested fix. Do not modify files.',
    source: 'builtin',
  },
  {
    name: 'planner',
    description: 'Planner: investigates and produces a step-by-step implementation plan without changing anything.',
    tools: ['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch'],
    prompt: 'Investigate the problem and produce a concrete, ordered implementation plan with the files to touch, risks and how to verify. Do not modify anything.',
    source: 'builtin',
  },
];

function loadDir(dir: string, source: AgentDefinition['source']): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const { data, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, f), 'utf8'));
      const tools = typeof data.tools === 'string' ? data.tools.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(data.tools) ? data.tools.map(String) : undefined;
      out.push({
        name: String(data.name ?? f.replace(/\.md$/, '')),
        description: String(data.description ?? ''),
        tools,
        model: data.model && data.model !== 'inherit' ? String(data.model) : undefined,
        prompt: body.trim(),
        source,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function loadAgentDefinitions(opts: { userDir: string; cwd: string; claudeCompat: boolean }): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  const add = (list: AgentDefinition[]) => list.forEach((d) => map.set(d.name, d));
  add(BUILTIN);
  if (opts.claudeCompat) {
    add(loadDir(join(homedir(), '.claude', 'agents'), 'claude'));
    add(loadDir(join(opts.cwd, '.claude', 'agents'), 'claude'));
  }
  add(loadDir(opts.userDir, 'user'));
  add(loadDir(join(opts.cwd, '.kronos', 'agents'), 'project'));
  return [...map.values()];
}
