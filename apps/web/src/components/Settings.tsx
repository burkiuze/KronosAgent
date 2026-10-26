import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Sparkles,
  MessageCircle,
  Palette,
  Monitor,
  Shield,
  Brain,
  Mic,
  SlidersHorizontal,
  Radio,
  KeyRound,
  Package,
  Network,
  Info,
  Download,
  Upload,
  RotateCcw,
  Sun,
  Moon,
  Check,
  Plus,
  Trash2,
  RefreshCw,
  Search,
  Github,
} from 'lucide-react';
import { api, del, downloadUrl, get, post, put } from '../lib/api';
import { setState, toast, useStore } from '../lib/store';
import { cfgGet, loadConfig, pathPatch, updateConfig, useConfig, type Config } from '../lib/config';
import { THEMES } from '../lib/themes';
import { t } from '../lib/i18n';
import { Badge, Modal, Toggle } from './ui';
import { KronosMark } from './Logo';
import { ProviderConnect } from './ProviderConnect';
import { GitHubSettings } from './GitHub';
import type { McpStatus, ModelInfo } from '../lib/types';

type Kind = 'toggle' | 'select' | 'number' | 'text' | 'textarea' | 'list' | 'model';

interface Def {
  section: string;
  key: string;
  label: string;
  desc?: string;
  kind: Kind;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium (recommended)' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Maximum' },
  { value: 'codemaster', label: 'Codemaster — max effort + plan, parallel agents, tests, review' },
];

const DEFS: Def[] = [
  { section: 'model', key: 'model.default', label: 'Default model', desc: '"auto" picks the best configured provider. Use provider:model, e.g. anthropic:claude-opus-5-5.', kind: 'model' },
  { section: 'model', key: 'model.effort', label: 'Reasoning effort', desc: 'How hard the model thinks. Medium is the balanced default; Codemaster adds a plan → parallel exploration → tests → independent review workflow.', kind: 'select', options: EFFORTS },
  { section: 'model', key: 'model.thinking', label: 'Extended thinking', desc: 'Let models reason before answering (where supported).', kind: 'toggle' },
  {
    section: 'model',
    key: 'model.toolMode',
    label: 'Tool calling',
    desc: 'How tools reach the model. Auto uses native function calling and switches a model to the text protocol when it cannot take tools. Choose Text for old or small models that call tools badly.',
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'native', label: 'Native' },
      { value: 'text', label: 'Text protocol' },
    ],
  },
  {
    section: 'model',
    key: 'agent.lean',
    label: 'Lean mode for small models',
    desc: 'Core tools only, short tool descriptions and a compact prompt — about 70% less fixed context. Auto turns it on for models with a context window of 32k tokens or less.',
    kind: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  },
  { section: 'model', key: 'model.showThinking', label: 'Show thinking', desc: 'Stream reasoning summaries into the chat.', kind: 'toggle' },
  { section: 'model', key: 'model.fallbacks', label: 'Fallback models', desc: 'Tried in order when the primary model fails.', kind: 'list', placeholder: 'openai:gpt-5.5, openrouter:…' },
  { section: 'model', key: 'model.advisors', label: 'Advisor models (/moa)', desc: 'With /moa, these models advise before key steps and after failures; the acting model decides. Empty = a fresh second opinion from the same model.', kind: 'list', placeholder: 'openai:gpt-5.5, gemini:gemini-3-pro' },
  { section: 'model', key: 'model.subagent', label: 'Subagent model', desc: 'Model for delegated subagents (empty = same as parent). A cheaper model saves cost.', kind: 'model' },
  { section: 'model', key: 'model.summary', label: 'Summary/title model', desc: 'Used for compaction and titles (empty = automatic small model).', kind: 'model' },
  { section: 'model', key: 'model.maxOutputTokens', label: 'Max output tokens', kind: 'number', min: 1024, max: 300000, step: 1024 },
  { section: 'model', key: 'model.temperature', label: 'Temperature', desc: 'Only for models that accept sampling parameters (not current Claude models).', kind: 'number', min: 0, max: 2, step: 0.1 },

  { section: 'chat', key: 'agent.name', label: 'Agent name', kind: 'text' },
  { section: 'chat', key: 'agent.personality', label: 'Personality', kind: 'select', options: [] },
  { section: 'chat', key: 'agent.language', label: 'Reply language', desc: '"auto" mirrors your language.', kind: 'text', placeholder: 'auto' },
  { section: 'chat', key: 'agent.instructions', label: 'Custom instructions', desc: 'Added to every conversation (like a global KRONOS.md).', kind: 'textarea' },
  { section: 'chat', key: 'agent.maxIterations', label: 'Max tool iterations per message', kind: 'number', min: 1, max: 1000 },
  { section: 'chat', key: 'agent.budget.maxCostUsd', label: 'Cost limit per message ($)', desc: 'Stop a run cleanly when it has spent this much (0 = no limit). Say "continue" to go on.', kind: 'number', min: 0, max: 1000, step: 0.5 },
  { section: 'chat', key: 'agent.budget.maxTokens', label: 'Token limit per message', desc: '0 = no limit.', kind: 'number', min: 0, max: 100000000, step: 10000 },
  { section: 'chat', key: 'agent.budget.maxMinutes', label: 'Time limit per message (minutes)', desc: '0 = no limit.', kind: 'number', min: 0, max: 1440 },
  { section: 'chat', key: 'agent.verifyBeforeFinish', label: 'Verify before finishing', desc: 'When Kronos changed files but never ran the project checks, it is asked to verify once before it reports back.', kind: 'toggle' },
  { section: 'chat', key: 'agent.selfReview', label: 'Self-review before finishing', desc: 'When a run changed 15+ lines in a git repository, the review engine checks the uncommitted changes and hands confirmed problems back before the final answer. "Codemaster" does this only at the Codemaster effort level.', kind: 'select', options: [{ value: 'off', label: 'Off' }, { value: 'codemaster', label: 'Codemaster only' }, { value: 'always', label: 'Always' }] },
  { section: 'chat', key: 'agent.parallelTools', label: 'Parallel tool calls', desc: 'Run independent read-only tools concurrently.', kind: 'toggle' },
  { section: 'chat', key: 'agent.autoTitle', label: 'Auto-title conversations', kind: 'toggle' },
  { section: 'chat', key: 'agent.toolOutputLimit', label: 'Tool output limit (chars)', desc: 'Longer output is truncated in the middle and saved to a file.', kind: 'number', min: 2000, max: 500000, step: 1000 },
  { section: 'chat', key: 'agent.compaction.enabled', label: 'Automatic compaction', desc: 'Summarize the conversation when the context window fills up.', kind: 'toggle' },
  { section: 'chat', key: 'agent.compaction.threshold', label: 'Compaction threshold', desc: 'Fraction of the context window that triggers compaction.', kind: 'number', min: 0.3, max: 0.95, step: 0.05 },
  { section: 'chat', key: 'agent.subagents.maxConcurrent', label: 'Parallel subagents', kind: 'number', min: 1, max: 16 },
  { section: 'chat', key: 'agent.subagents.maxDepth', label: 'Delegation depth', kind: 'number', min: 1, max: 4 },
  { section: 'chat', key: 'agent.lsp', label: 'Language-server checks after edits', desc: 'Auto: after each edit, an installed language server (typescript-language-server, pyright, gopls, rust-analyzer, clangd) reports the type errors the edit introduced. Servers stop after 5 idle minutes.', kind: 'select', options: [{ value: 'off', label: 'Off' }, { value: 'auto', label: 'Auto (when installed)' }] },
  { section: 'chat', key: 'review.model', label: 'Code review model', desc: 'Model for /review and pull request reviews (empty = default model).', kind: 'model' },
  { section: 'chat', key: 'review.verify', label: 'Fact-check review findings', desc: 'A second pass tries to refute every finding against the code and drops the ones it disproves.', kind: 'toggle' },
  {
    section: 'chat',
    key: 'review.minSeverity',
    label: 'Review findings to report',
    kind: 'select',
    options: [
      { value: 'low', label: 'All (low and up)' },
      { value: 'medium', label: 'Medium and up' },
      { value: 'high', label: 'High and critical' },
      { value: 'critical', label: 'Critical only' },
    ],
  },
  { section: 'chat', key: 'ui.sendOnEnter', label: 'Send on Enter', desc: 'Off: ⌘/Ctrl+Enter sends.', kind: 'toggle' },

  { section: 'workspace', key: 'terminal.cwd', label: 'Default workspace', desc: 'Working directory for new conversations (empty = where Kronos was started).', kind: 'text', placeholder: '~/projects' },
  { section: 'workspace', key: 'terminal.backend', label: 'Terminal backend', desc: 'Where commands run. Docker = isolated sandbox with the workspace mounted.', kind: 'select', options: [{ value: 'local', label: 'Local' }, { value: 'docker', label: 'Docker sandbox' }, { value: 'ssh', label: 'SSH remote' }] },
  {
    section: 'workspace',
    key: 'terminal.sandbox.mode',
    label: 'OS sandbox (local backend)',
    desc: 'Confine commands without Docker: Landlock on Linux, Seatbelt on macOS. Workspace = only the project and temp can be changed.',
    kind: 'select',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'workspace-write', label: 'Workspace write' },
      { value: 'read-only', label: 'Read-only' },
    ],
  },
  { section: 'workspace', key: 'terminal.sandbox.network', label: 'Sandbox network access', desc: 'Off: sandboxed commands cannot open network connections — except to the allowed domains below.', kind: 'toggle' },
  { section: 'workspace', key: 'terminal.sandbox.allowDomains', label: 'Allowed domains (network off)', desc: 'Reachable through Kronos\'s filtering proxy, e.g. registry.npmjs.org, pypi.org, **.github.com. *.x = subdomains, **.x = domain and subdomains.', kind: 'list', placeholder: 'registry.npmjs.org, **.github.com' },
  { section: 'workspace', key: 'terminal.timeoutSec', label: 'Command timeout (s)', kind: 'number', min: 5, max: 7200 },
  { section: 'workspace', key: 'terminal.docker.image', label: 'Docker image', kind: 'text' },
  { section: 'workspace', key: 'terminal.docker.network', label: 'Docker network access', kind: 'toggle' },
  { section: 'workspace', key: 'terminal.ssh.host', label: 'SSH host', kind: 'text' },
  { section: 'workspace', key: 'terminal.ssh.user', label: 'SSH user', kind: 'text' },
  { section: 'workspace', key: 'terminal.ssh.workdir', label: 'SSH working directory', kind: 'text' },

  {
    section: 'safety',
    key: 'safety.mode',
    label: 'Default permission mode',
    kind: 'select',
    options: [
      { value: 'ask', label: 'Ask — approve edits & commands' },
      { value: 'auto-edit', label: 'Auto-edit — edits auto-approved' },
      { value: 'yolo', label: 'YOLO — everything auto-approved' },
      { value: 'plan', label: 'Plan — read-only' },
    ],
  },
  { section: 'safety', key: 'safety.dangerousCommands', label: 'Dangerous commands', desc: 'rm -rf /, force pushes, DROP TABLE, curl | sh …', kind: 'select', options: [{ value: 'ask', label: 'Always ask' }, { value: 'block', label: 'Block' }, { value: 'allow', label: 'Allow (not recommended)' }] },
  { section: 'safety', key: 'safety.allow', label: 'Allow rules', desc: 'Never ask for these, e.g. shell(npm test*), write_file(src/**), mcp__github__*', kind: 'list' },
  { section: 'safety', key: 'safety.deny', label: 'Deny rules', desc: 'Always refuse these.', kind: 'list' },
  { section: 'safety', key: 'safety.protectedPaths', label: 'Protected paths', desc: 'Writes always ask.', kind: 'list' },
  { section: 'safety', key: 'safety.workspaceOnly', label: 'Restrict writes to the workspace', kind: 'toggle' },
  {
    section: 'safety',
    key: 'safety.guardian.mode',
    label: 'Safety reviewer',
    desc: 'A second model judges actions that need approval — risk against what you actually asked for. Unattended: only when nobody can answer (GitHub bot, automations). Always: before every approval prompt.',
    kind: 'select',
    options: [
      { value: 'unattended', label: 'Unattended runs' },
      { value: 'always', label: 'Always' },
      { value: 'off', label: 'Off' },
    ],
  },
  { section: 'safety', key: 'safety.checkpoints', label: 'File checkpoints', desc: 'Snapshot files before edits so /undo can restore them.', kind: 'toggle' },
  { section: 'safety', key: 'safety.redactSecrets', label: 'Redact secrets in tool output', kind: 'toggle' },

  {
    section: 'memory',
    key: 'agent.nudges.learning',
    label: 'Learning from conversations',
    desc: 'Background: after a substantial turn or a correction, a separate agent updates memory and skills — the conversation is not interrupted. Inline: remind the agent in the chat instead.',
    kind: 'select',
    options: [
      { value: 'background', label: 'In the background' },
      { value: 'inline', label: 'Inline reminders' },
      { value: 'off', label: 'Off' },
    ],
  },
  { section: 'memory', key: 'memory.recaps', label: 'Remember past work', desc: 'After a conversation goes quiet, Kronos writes its task history to a recap file and keeps an index of past work in every new conversation — so "continue yesterday\'s refactor" just works. Uses a few background model calls.', kind: 'toggle' },
  { section: 'memory', key: 'memory.enabled', label: 'Persistent memory', kind: 'toggle' },
  { section: 'memory', key: 'memory.memoryCharLimit', label: 'MEMORY.md limit (chars)', kind: 'number', min: 500, max: 50000, step: 500 },
  { section: 'memory', key: 'memory.userCharLimit', label: 'USER.md limit (chars)', kind: 'number', min: 500, max: 50000, step: 500 },
  { section: 'memory', key: 'memory.sessionSearch', label: 'Session search', desc: 'Let Kronos search past conversations.', kind: 'toggle' },
  { section: 'memory', key: 'agent.nudges.memoryEvery', label: 'Memory nudge every N turns', desc: '0 disables.', kind: 'number', min: 0, max: 100 },
  { section: 'memory', key: 'skills.autoCreate', label: 'Self-improving skills', desc: 'Nudge Kronos to save complex workflows as skills.', kind: 'toggle' },
  { section: 'memory', key: 'agent.nudges.skillAfterToolCalls', label: 'Skill nudge after N tool calls', kind: 'number', min: 3, max: 200 },
  { section: 'memory', key: 'skills.editBudget', label: 'Skill edits per session', desc: 'How many skills Kronos may create or change in one conversation. Every change is versioned and can be restored.', kind: 'number', min: 0, max: 20 },
  { section: 'memory', key: 'skills.staleAfterDays', label: 'Flag unused skills after (days)', desc: 'Skills Kronos wrote that go unused this long are offered for review.', kind: 'number', min: 7, max: 365 },

  { section: 'voice', key: 'voice.stt', label: 'Speech-to-text', kind: 'select', options: [{ value: 'openai', label: 'OpenAI Whisper' }, { value: 'groq', label: 'Groq Whisper' }, { value: 'none', label: 'Browser only' }] },
  { section: 'voice', key: 'voice.tts', label: 'Text-to-speech', kind: 'select', options: [{ value: 'browser', label: 'System voice' }, { value: 'openai', label: 'OpenAI TTS' }, { value: 'elevenlabs', label: 'ElevenLabs' }, { value: 'none', label: 'Off' }] },
  { section: 'voice', key: 'voice.voice', label: 'Voice', kind: 'text', placeholder: 'alloy' },

  { section: 'advanced', key: 'web.search.provider', label: 'Web search provider', desc: 'auto uses the first configured key, otherwise DuckDuckGo.', kind: 'select', options: ['auto', 'duckduckgo', 'brave', 'tavily', 'exa', 'serper', 'searxng', 'jina'].map((v) => ({ value: v, label: v })) },
  { section: 'advanced', key: 'web.search.url', label: 'SearXNG URL', kind: 'text' },
  { section: 'advanced', key: 'browser.headless', label: 'Headless browser', kind: 'toggle' },
  { section: 'advanced', key: 'image.provider', label: 'Image generation', kind: 'select', options: ['openai', 'fal', 'replicate', 'none'].map((v) => ({ value: v, label: v })) },
  { section: 'advanced', key: 'image.model', label: 'Image model', kind: 'text' },
  { section: 'advanced', key: 'cron.enabled', label: 'Automations scheduler', kind: 'toggle' },
  { section: 'advanced', key: 'cron.timezone', label: 'Automation timezone', desc: 'IANA name, e.g. Europe/Istanbul (empty = system).', kind: 'text' },
  { section: 'advanced', key: 'updates.autoCheck', label: 'Check for updates', kind: 'toggle' },
  { section: 'advanced', key: 'skills.claudeCompat', label: 'Claude Code compatibility', desc: 'Also load ~/.claude skills, agents and commands.', kind: 'toggle' },

  { section: 'gateway', key: 'gateway.host', label: 'Bind address', desc: '127.0.0.1 = this machine only. 0.0.0.0 exposes it (a token is then required).', kind: 'text' },
  { section: 'gateway', key: 'gateway.port', label: 'Port', kind: 'number', min: 1, max: 65535 },
  { section: 'gateway', key: 'gateway.openaiApi', label: 'OpenAI-compatible API (/v1)', kind: 'toggle' },
  { section: 'gateway', key: 'gateway.publicUrl', label: 'Public URL', desc: 'Used for webhook instructions (WhatsApp).', kind: 'text' },
  { section: 'gateway', key: 'gateway.cors', label: 'Allowed CORS origins', kind: 'list' },
];

const SECTIONS: { id: string; label: string; icon: typeof Sparkles; group: number }[] = [
  { id: 'model', label: 'Model', icon: Sparkles, group: 0 },
  { id: 'chat', label: 'Chat', icon: MessageCircle, group: 0 },
  { id: 'appearance', label: 'Appearance', icon: Palette, group: 0 },
  { id: 'workspace', label: 'Workspace', icon: Monitor, group: 0 },
  { id: 'safety', label: 'Safety', icon: Shield, group: 0 },
  { id: 'memory', label: 'Memory & Context', icon: Brain, group: 0 },
  { id: 'voice', label: 'Voice', icon: Mic, group: 0 },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, group: 0 },
  { id: 'gateway', label: 'Gateway', icon: Radio, group: 1 },
  { id: 'keys', label: 'Providers & API keys', icon: KeyRound, group: 1 },
  { id: 'tools', label: 'Skills & Tools', icon: Package, group: 1 },
  { id: 'github', label: 'GitHub', icon: Github, group: 1 },
  { id: 'mcp', label: 'MCP', icon: Network, group: 1 },
  { id: 'about', label: 'About', icon: Info, group: 2 },
];

function ModelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  useEffect(() => {
    void get<{ models: ModelInfo[] }>('/api/models').then((r) => setModels(r.models));
  }, []);
  return (
    <>
      <input list="kronos-models" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} placeholder="auto" />
      <datalist id="kronos-models">
        <option value="auto" />
        {models.map((m) => (
          <option key={m.ref} value={m.ref}>
            {m.name}
          </option>
        ))}
      </datalist>
    </>
  );
}

function Control({ def, config, personalities }: { def: Def; config: Config; personalities: { id: string; label: string }[] }) {
  const value = cfgGet(def.key, config);
  const commit = (v: unknown) => void updateConfig(pathPatch(def.key, v), true);
  switch (def.kind) {
    case 'toggle':
      return <Toggle checked={Boolean(value)} onChange={commit} />;
    case 'select': {
      const opts = def.key === 'agent.personality' ? personalities.map((p) => ({ value: p.id, label: p.label })) : (def.options ?? []);
      return (
        <select value={String(value ?? '')} onChange={(e) => commit(e.target.value)}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case 'number':
      return <input type="number" defaultValue={value ?? ''} min={def.min} max={def.max} step={def.step ?? 1} onBlur={(e) => commit(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'textarea':
      return <textarea rows={4} defaultValue={value ?? ''} onBlur={(e) => e.target.value !== value && commit(e.target.value)} />;
    case 'list':
      return <input defaultValue={(value ?? []).join(', ')} placeholder={def.placeholder} onBlur={(e) => commit(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
    case 'model':
      return <ModelInput value={value ?? ''} onCommit={(v) => commit(v || null)} />;
    default:
      return <input defaultValue={value ?? ''} placeholder={def.placeholder} onBlur={(e) => e.target.value !== (value ?? '') && commit(e.target.value)} />;
  }
}

function Card({ title, desc, badge, children }: { title: string; desc?: string; badge?: string; children: ReactNode }) {
  return (
    <div className="set-card">
      <div className="set-card-head">
        <div>
          <div className="set-title">{title}</div>
          {desc && <div className="set-desc">{desc}</div>}
        </div>
        {badge && <span className="set-badge">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function Appearance({ config }: { config: Config }) {
  const ui = config.ui ?? {};
  return (
    <>
      <Card title="Color mode" desc="Pick a fixed mode or follow your system setting." badge={ui.mode}>
        <div className="choice-grid three">
          {[
            { id: 'light', label: 'Light', desc: 'Bright desktop surfaces', icon: Sun },
            { id: 'dark', label: 'Dark', desc: 'Low-glare workspace', icon: Moon },
            { id: 'system', label: 'System', desc: 'Follow OS appearance', icon: Monitor },
          ].map((m) => (
            <button key={m.id} className={`choice ${ui.mode === m.id ? 'selected' : ''}`} onClick={() => void updateConfig({ ui: { mode: m.id } }, true)}>
              <span className="choice-icon">
                <m.icon size={15} />
              </span>
              <b>{m.label}</b>
              <span>{m.desc}</span>
              {ui.mode === m.id && <Check size={14} className="choice-check" />}
            </button>
          ))}
        </div>
      </Card>
      <Card title="Tool call display" desc="Product hides raw tool payloads; Technical shows full input/output." badge={ui.toolDisplay}>
        <div className="choice-grid two">
          {[
            { id: 'product', label: 'Product', desc: 'Human-friendly tool activity with concise summaries.' },
            { id: 'technical', label: 'Technical', desc: 'Include raw tool args/results and low-level details.' },
          ].map((m) => (
            <button key={m.id} className={`choice ${ui.toolDisplay === m.id ? 'selected' : ''}`} onClick={() => void updateConfig({ ui: { toolDisplay: m.id } }, true)}>
              <b>{m.label}</b>
              <span>{m.desc}</span>
              {ui.toolDisplay === m.id && <Check size={14} className="choice-check" />}
            </button>
          ))}
        </div>
      </Card>
      <Card title="Theme" desc="Palettes for the whole app. The color mode is applied on top." badge={THEMES.find((x) => x.id === ui.theme)?.name}>
        <div className="theme-grid">
          {THEMES.map((th) => {
            const mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
            const tk = th[mode];
            return (
              <button key={th.id} className={`theme-card ${ui.theme === th.id ? 'selected' : ''}`} onClick={() => void updateConfig({ ui: { theme: th.id } }, true)}>
                <div className="theme-preview" style={{ background: tk.bg, borderColor: tk.border }}>
                  <div className="tp-side" style={{ background: tk.sidebar, borderColor: tk.border }} />
                  <div className="tp-line" style={{ background: tk.text, width: '42%' }} />
                  <div className="tp-line" style={{ background: tk.dim, width: '62%', opacity: 0.6 }} />
                  <div className="tp-pill" style={{ background: tk.accentSoft, borderColor: tk.accent }} />
                </div>
                <div className="theme-meta">
                  <b>{th.name}</b>
                  <span>{th.description}</span>
                </div>
                {ui.theme === th.id && <Check size={14} className="choice-check" />}
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Text & density">
        <div className="row-controls">
          <label>
            Font size
            <input type="range" min={12} max={18} value={ui.fontSize ?? 14} onChange={(e) => void updateConfig({ ui: { fontSize: Number(e.target.value) } }, true)} />
            <span>{ui.fontSize ?? 14}px</span>
          </label>
          <label>
            Density
            <select value={ui.density ?? 'comfortable'} onChange={(e) => void updateConfig({ ui: { density: e.target.value } }, true)}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </div>
      </Card>
    </>
  );
}

interface KeyRow {
  name: string;
  set: boolean;
  preview: string | null;
}

function Keys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [providers, setProviders] = useState<{ id: string; label: string; configured: boolean; envKeys: string[]; docsUrl?: string; local: boolean; baseUrl: string }[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const load = () => {
    void get<{ keys: KeyRow[] }>('/api/keys').then((r) => setKeys(r.keys));
    void get<typeof providers>('/api/providers').then(setProviders);
  };
  useEffect(load, []);
  const save = async (name: string, value: string | null) => {
    await put('/api/keys', { name, value });
    toast(value ? `${name} saved` : `${name} removed`);
    setValues((v) => ({ ...v, [name]: '' }));
    load();
    void loadConfig();
  };
  const providerKeys = new Set(providers.flatMap((p) => p.envKeys));
  const other = keys.filter((k) => !providerKeys.has(k.name));
  const row = (name: string, label: string, link?: string) => {
    const k = keys.find((x) => x.name === name);
    return (
      <div key={name} className="key-row">
        <div className="key-meta">
          <b>{label}</b>
          <code>{name}</code>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="small">
              get key ↗
            </a>
          )}
        </div>
        <input type="password" placeholder={k?.set ? `${k.preview} (saved)` : 'not set'} value={values[name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} />
        <button className="btn small" disabled={!values[name]} onClick={() => void save(name, values[name] ?? '')}>
          Save
        </button>
        {k?.set && (
          <button className="icon-btn tiny" title="Remove" onClick={() => void save(name, null)}>
            <Trash2 size={13} />
          </button>
        )}
        {k?.set ? <Badge tone="ok">set</Badge> : <Badge>—</Badge>}
      </div>
    );
  };
  return (
    <>
      <Card title={t('pv.title')} desc={t('pv.desc')}>
        <ProviderConnect onChanged={load} />
      </Card>
      <Card title="Tools & integrations" desc="Web search, image, voice and other service keys.">
        {other.map((k) => row(k.name, k.name.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())))}
      </Card>
    </>
  );
}

function Mcp() {
  const [servers, setServers] = useState<McpStatus[]>([]);
  const [draft, setDraft] = useState({ name: '', command: '', url: '' });
  const [busy, setBusy] = useState(false);
  const load = () => void get<{ servers: McpStatus[] }>('/api/mcp').then((r) => setServers(r.servers));
  useEffect(load, []);
  return (
    <>
      <Card title="MCP servers" desc="Connect any Model Context Protocol server (stdio command or HTTP URL). Its tools appear as mcp__<server>__<tool>.">
        {servers.map((s) => (
          <div key={s.name} className="key-row">
            <div className="key-meta">
              <b>{s.name}</b>
              <code>{s.transport}</code>
            </div>
            <span className="muted small">{s.error ? s.error.slice(0, 120) : `${s.tools.length} tools`}</span>
            <Badge tone={s.status === 'connected' ? 'ok' : s.status === 'error' ? 'error' : 'neutral'}>{s.status}</Badge>
            <button className="icon-btn tiny" title="Reconnect" onClick={async () => (await post(`/api/mcp/${s.name}/reconnect`), load())}>
              <RefreshCw size={13} />
            </button>
            <button className="icon-btn tiny" title="Remove" onClick={async () => (await del(`/api/mcp/${s.name}`), load())}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {!servers.length && <div className="muted small">No servers yet.</div>}
      </Card>
      <Card title="Add a server">
        <div className="inline-form">
          <input placeholder="name (e.g. github)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="command, e.g. npx -y @modelcontextprotocol/server-github" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          <input placeholder="…or URL https://…/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          <button
            className="btn small primary"
            disabled={!draft.name || (!draft.command && !draft.url) || busy}
            onClick={async () => {
              setBusy(true);
              const [command, ...args] = draft.command.trim().split(/\s+/);
              try {
                const r = await post<McpStatus>('/api/mcp', draft.url ? { name: draft.name, url: draft.url } : { name: draft.name, command, args });
                toast(r.status === 'connected' ? `${draft.name}: ${r.tools.length} tools` : `${draft.name}: ${r.error}`, r.status === 'connected' ? 'ok' : 'error');
                setDraft({ name: '', command: '', url: '' });
                load();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <p className="muted small">Popular: filesystem, github, playwright, postgres, slack, linear, sentry, figma. Kronos itself can be used as an MCP server: <code>kronos mcp serve</code>.</p>
      </Card>
    </>
  );
}

function Tools({ config }: { config: Config }) {
  return (
    <>
      <Card title="Toolsets" desc="Enable or disable whole capability groups.">
        <button className="btn small" onClick={() => setState({ settings: null, view: 'skills' })}>
          Open Skills & Toolsets
        </button>
      </Card>
      <Card title="Extra skill folders" desc="Additional directories scanned for SKILL.md.">
        <input defaultValue={(config.skills?.dirs ?? []).join(', ')} onBlur={(e) => void updateConfig({ skills: { dirs: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } }, true)} />
      </Card>
      <Card title="Lifecycle hooks" desc='Shell commands run on events with JSON on stdin. Exit code 2 (or {"decision":"block"}) blocks. Events: preToolUse, postToolUse, userPromptSubmit, sessionStart, stop.'>
        <HooksEditor value={config.hooks ?? {}} />
      </Card>
    </>
  );
}

function HooksEditor({ value }: { value: Config }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [err, setErr] = useState('');
  return (
    <>
      <textarea className="code-area" rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {err && <div className="danger small">{err}</div>}
      <button
        className="btn small"
        onClick={() => {
          try {
            const v = JSON.parse(text);
            setErr('');
            void updateConfig({ hooks: v });
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        Save hooks
      </button>
      <p className="muted small">Example: {'{"preToolUse":[{"matcher":"shell","command":"./scripts/guard.sh"}],"stop":[{"command":"notify-send Kronos done"}]}'}</p>
    </>
  );
}

function About() {
  const status = useStore((s) => s.status);
  const [doctor, setDoctor] = useState<{ check: string; ok: boolean; detail: string }[]>([]);
  const [update, setUpdate] = useState<{ current: string; latest: string | null; available: boolean; url?: string } | null>(null);
  useEffect(() => {
    void get<typeof doctor>('/api/doctor').then(setDoctor);
    void get<typeof update>('/api/update').then(setUpdate);
  }, []);
  return (
    <>
      <div className="about-hero">
        <KronosMark size={56} />
        <div>
          <h2>KRONOS AGENT</h2>
          <div className="muted">
            v{status?.version} · profile <b>{status?.profile}</b> · {status?.sessionStore === 'sqlite' ? 'SQLite + FTS5' : 'JSON'} store
          </div>
          <div className="muted small">{status?.home}</div>
        </div>
      </div>
      <Card title="Updates" badge={update?.available ? 'available' : 'up to date'}>
        {update?.available ? (
          <p>
            Kronos {update.latest} is available.{' '}
            <a href={update.url} target="_blank" rel="noreferrer">
              Release notes ↗
            </a>
          </p>
        ) : (
          <p className="muted">You are on the latest version ({update?.current ?? status?.version}).</p>
        )}
      </Card>
      <Card title="Diagnostics">
        {doctor.map((d) => (
          <div key={d.check} className="doctor-row">
            <span className={d.ok ? 'ok-text' : 'warn-text'}>{d.ok ? '✓' : '!'}</span>
            <b>{d.check}</b>
            <span className="muted">{d.detail}</span>
          </div>
        ))}
      </Card>
      <Card title="Keyboard shortcuts">
        <div className="shortcuts">
          {[
            ['⌘K', 'Command palette'],
            ['⌘N', 'New conversation'],
            ['⌘,', 'Settings'],
            ['⌘B', 'Toggle sidebar'],
            ['⌘J', 'Files & terminal'],
            ['⌘.', 'Stop the agent'],
            ['Esc', 'Stop / close'],
            ['Shift-click', 'Pin a chat'],
          ].map(([k, v]) => (
            <div key={k}>
              <kbd>{k}</kbd> {v}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

export function SettingsModal() {
  const section = useStore((s) => s.settings);
  const { config, personalities } = useConfig();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? DEFS.filter((d) => `${d.label} ${d.desc ?? ''} ${d.key}`.toLowerCase().includes(q)) : []), [q]);
  if (!section) return null;
  const close = () => setState({ settings: null });
  const defs = q ? matches : DEFS.filter((d) => d.section === section);
  const custom = !q && ['appearance', 'keys', 'github', 'mcp', 'tools', 'about'].includes(section);
  const meta = SECTIONS.find((s) => s.id === section);
  return (
    <Modal open onClose={close} className="settings-modal" wide>
      <div className="settings">
        <aside className="settings-nav">
          {SECTIONS.map((s, i) => (
            <div key={s.id}>
              {i > 0 && SECTIONS[i - 1]?.group !== s.group && <div className="settings-sep" />}
              <button className={`settings-nav-item ${section === s.id && !q ? 'active' : ''}`} onClick={() => (setQuery(''), setState({ settings: s.id }))}>
                <s.icon size={15} />
                {s.label}
              </button>
            </div>
          ))}
          <div className="flex-1" />
          <div className="settings-foot">
            <a className="icon-btn" title="Export settings" href={downloadUrl('/api/config/export')}>
              <Download size={15} />
            </a>
            <label className="icon-btn" title="Import settings">
              <Upload size={15} />
              <input
                type="file"
                accept=".yaml,.yml,.json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await api('/api/config/import', { method: 'POST', body: await f.text(), headers: { 'content-type': 'text/yaml' } });
                  await loadConfig();
                  toast('Settings imported');
                }}
              />
            </label>
            <button
              className="icon-btn"
              title="Reset to defaults"
              onClick={async () => {
                if (!confirm('Reset all settings for this profile to defaults? (a backup is kept)')) return;
                await post('/api/config/reset');
                await loadConfig();
                toast('Settings reset');
              }}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </aside>
        <div className="settings-main">
          <div className="settings-search">
            <Search size={14} />
            <input placeholder={t('settings.search')} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          </div>
          {!q && meta && (
            <div className="settings-section-head">
              <meta.icon size={15} /> {meta.label}
            </div>
          )}
          {config &&
            (custom ? (
              section === 'appearance' ? (
                <Appearance config={config} />
              ) : section === 'keys' ? (
                <Keys />
              ) : section === 'github' ? (
                <GitHubSettings />
              ) : section === 'mcp' ? (
                <Mcp />
              ) : section === 'tools' ? (
                <Tools config={config} />
              ) : (
                <About />
              )
            ) : defs.length ? (
              <div className="set-list">
                {defs.map((d) => (
                  <div key={d.key} className="set-row">
                    <div className="set-text">
                      <div className="set-title">{d.label}</div>
                      {d.desc && <div className="set-desc">{d.desc}</div>}
                      {q && <div className="set-key">{SECTIONS.find((s) => s.id === d.section)?.label}</div>}
                    </div>
                    <div className={`set-control ${d.kind}`}>
                      <Control def={d} config={config} personalities={personalities} />
                    </div>
                  </div>
                ))}
                {section === 'gateway' && !q && (
                  <div className="set-row">
                    <div className="set-text">
                      <div className="set-title">Messaging platforms</div>
                      <div className="set-desc">Telegram, Discord, Slack, Matrix, WhatsApp, Signal, webhooks.</div>
                    </div>
                    <button className="btn small" onClick={() => setState({ settings: null, view: 'messaging' })}>
                      Open Messaging
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty small">
                <h3>{t('settings.noMatch')}</h3>
                <p className="muted">Try a different search term or choose another section.</p>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
}
