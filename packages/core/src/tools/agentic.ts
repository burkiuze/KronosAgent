import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ToolDefinition } from './types.js';
import type { Todo } from '../types.js';
import type { MemoryTarget } from '../memory/store.js';
import { resolvePath } from '../config/paths.js';
import { generateImage, imageProviderStatus, textToSpeech } from '../media/media.js';
import { truncate } from '../util/text.js';
import { newId, formatDuration } from '../util/misc.js';
import { PLATFORM_LABELS, type PlatformId } from '../messaging/senders.js';

// ---------------------------------------------------------------------------
// Memory & recall
// ---------------------------------------------------------------------------

export const memoryTool: ToolDefinition<{
  action: 'add' | 'patch' | 'remove' | 'search' | 'view';
  target?: MemoryTarget;
  content?: string;
  old_text?: string;
  query?: string;
}> = {
  name: 'memory',
  toolset: 'memory',
  risk: 'read',
  description:
    'Your persistent, bounded memory across sessions. target "memory" = your own notes (environment facts, conventions, lessons learned); ' +
    'target "user" = the user profile (preferences, style, projects, people). Actions: add{content}, patch{old_text, content} (replace a unique span), ' +
    'remove{old_text}, search{query}, view. Save durable facts proactively and concisely; never store secrets. When full, consolidate entries.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'patch', 'remove', 'search', 'view'] },
      target: { type: 'string', enum: ['memory', 'user'] },
      content: { type: 'string' },
      old_text: { type: 'string', description: 'Unique substring identifying the entry (patch/remove).' },
      query: { type: 'string' },
    },
    required: ['action'],
  },
  summarize: (i) => (i.action === 'add' ? `Remember: ${truncate(i.content ?? '', 60)}` : `Memory ${i.action}`),
  async execute(input, ctx) {
    const mem = ctx.runtime.memory;
    const target: MemoryTarget = input.target === 'user' ? 'user' : 'memory';
    switch (input.action) {
      case 'add': {
        if (!input.content) return { content: 'content is required', isError: true };
        const r = mem.add(target, input.content, ctx.sessionId);
        return { content: r.message, isError: !r.ok };
      }
      case 'patch': {
        if (!input.old_text || input.content === undefined) return { content: 'old_text and content are required', isError: true };
        const r = mem.patch(target, input.old_text, input.content, ctx.sessionId);
        return { content: r.message, isError: !r.ok };
      }
      case 'remove': {
        if (!input.old_text) return { content: 'old_text is required', isError: true };
        const r = mem.remove(target, input.old_text, ctx.sessionId);
        return { content: r.message, isError: !r.ok };
      }
      case 'search': {
        const hits = mem.search(input.query ?? input.content ?? '');
        return { content: hits.length ? hits.map((h) => `[${h.target}] ${h.entry}`).join('\n§\n') : 'No matching memories.' };
      }
      case 'view':
      default:
        return { content: `${mem.render('memory')}\n\n${mem.render('user')}` };
    }
  },
};

export const sessionSearchTool: ToolDefinition<{ query: string; limit?: number }> = {
  name: 'session_search',
  toolset: 'sessions',
  risk: 'read',
  parallelSafe: true,
  description: 'Full-text search across all past conversations (titles, messages, tool output). Use it to recall earlier work, decisions or details the user mentioned before.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
    required: ['query'],
  },
  summarize: (i) => `Search past sessions for "${truncate(i.query, 50)}"`,
  async execute(input, ctx) {
    const hits = ctx.runtime.sessions.search(input.query, { limit: input.limit ?? 10, excludeSession: ctx.sessionId });
    if (!hits.length) return { content: `No past conversations match "${input.query}".` };
    return {
      content: hits
        .map((h) => `• [${new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] "${h.title}" (session ${h.sessionId}, ${h.role})\n  ${h.snippet}`)
        .join('\n'),
    };
  },
};

// ---------------------------------------------------------------------------
// Planning & clarification
// ---------------------------------------------------------------------------

export const todoTool: ToolDefinition<{ todos: { content: string; status: Todo['status']; activeForm?: string; id?: string }[] }> = {
  name: 'todo_write',
  toolset: 'todo',
  risk: 'read',
  description:
    'Create or update the task list for multi-step work (3+ steps). Send the full list every time. Exactly one item should be in_progress while working; ' +
    'mark items completed immediately when done. The user sees this list live.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            activeForm: { type: 'string', description: 'Present-continuous label shown while in progress.' },
            id: { type: 'string' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summarize: (i) => {
    const done = (i.todos ?? []).filter((t) => t.status === 'completed').length;
    return `Update plan (${done}/${i.todos?.length ?? 0} done)`;
  },
  async execute(input, ctx) {
    const todos: Todo[] = input.todos.map((t, i) => ({ id: t.id ?? String(i + 1), content: t.content, status: t.status, activeForm: t.activeForm }));
    ctx.agent.setTodos(todos);
    const icon = { pending: '☐', in_progress: '◐', completed: '☑', cancelled: '☒' } as const;
    return { content: todos.map((t) => `${icon[t.status]} ${t.content}`).join('\n'), meta: { todos } };
  },
};

export const askUserTool: ToolDefinition<{ question: string; options?: string[] }> = {
  name: 'ask_user',
  toolset: 'clarify',
  risk: 'read',
  description: 'Ask the user a question and wait for the answer. Only when genuinely blocked on a decision that is theirs to make; otherwise make a sensible choice and proceed.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (the user may also type their own).' },
    },
    required: ['question'],
  },
  summarize: (i) => `Ask: ${truncate(i.question, 70)}`,
  async execute(input, ctx) {
    const answer = await ctx.askUser(input.question, input.options);
    return { content: answer ? `User answered: ${answer}` : 'The user did not answer. Proceed with your best judgement and state the assumption.' };
  },
};

export const exitPlanModeTool: ToolDefinition<{ plan: string }> = {
  name: 'exit_plan_mode',
  toolset: 'core',
  risk: 'read',
  description: 'In plan mode: present your implementation plan (markdown) for the user to approve. If approved, you leave plan mode and can start making changes.',
  parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
  summarize: () => 'Present plan for approval',
  async execute(input, ctx) {
    if (ctx.agent.mode !== 'plan') return { content: 'Not in plan mode — proceed with the work.' };
    const r = await ctx.agent.requestPlanApproval(input.plan);
    return r.approved
      ? { content: `The user approved the plan. You are now in "${ctx.agent.mode}" mode — implement it, keeping the todo list updated.` }
      : { content: `The user did not approve the plan.${r.feedback ? ` Feedback: ${r.feedback}` : ''} Revise it and call exit_plan_mode again.` };
  },
};

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export const delegateTool: ToolDefinition<{
  tasks: { task: string; label?: string; agent?: string; model?: string; toolsets?: string[] }[];
  context?: string;
}> = {
  name: 'delegate',
  toolset: 'delegate',
  risk: 'read',
  description:
    'Delegate self-contained work to subagents that run in parallel, each with a fresh context window, and get their final reports back. ' +
    'Use for parallel research, exploring several areas of a codebase, or independent sub-tasks. Each task must be fully specified ' +
    '(subagents cannot see this conversation; put shared background in `context`). Agent types: general, explorer, researcher, coder, reviewer, planner (plus user-defined).',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Complete instructions for the subagent.' },
            label: { type: 'string', description: 'Short label shown in the UI.' },
            agent: { type: 'string', description: 'Agent type (default "general").' },
            model: { type: 'string', description: 'Optional model override, e.g. "anthropic:claude-haiku-5-5".' },
            toolsets: { type: 'array', items: { type: 'string' } },
          },
          required: ['task'],
        },
      },
      context: { type: 'string', description: 'Shared background given to every subagent.' },
    },
    required: ['tasks'],
  },
  summarize: (i) => `Delegate ${i.tasks?.length ?? 0} task(s): ${(i.tasks ?? []).map((t) => t.label ?? truncate(t.task, 24)).join(', ')}`,
  async execute(input, ctx) {
    const results = await ctx.agent.delegate(input.tasks, { context: input.context, signal: ctx.signal, parentToolCallId: ctx.toolCallId });
    const body = results
      .map((r) => `## ${r.label} — ${r.ok ? 'done' : 'FAILED'} (${formatDuration(r.durationMs)}, session ${r.sessionId})\n${r.text || r.error || '(no output)'}`)
      .join('\n\n');
    return { content: body, isError: results.every((r) => !r.ok), meta: { subagents: results.map((r) => ({ label: r.label, ok: r.ok, sessionId: r.sessionId })) } };
  },
};

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skillsListTool: ToolDefinition<{ query?: string; category?: string }> = {
  name: 'skills_list',
  toolset: 'skills',
  risk: 'read',
  parallelSafe: true,
  description: 'List available skills (reusable procedures), optionally filtered by a search query or category.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } },
  summarize: (i) => (i.query ? `Find skills for "${i.query}"` : 'List skills'),
  async execute(input, ctx) {
    const reg = ctx.runtime.skills;
    let list = input.query ? reg.search(input.query, 20) : reg.list();
    if (input.category) list = list.filter((s) => s.category === input.category?.toLowerCase());
    if (!list.length) return { content: 'No matching skills. You can create one with skill_manage.' };
    return { content: list.map((s) => `- ${s.name} [${s.category}${s.source !== 'bundled' ? `, ${s.source}` : ''}]: ${s.description}`).join('\n') };
  },
};

export const skillViewTool: ToolDefinition<{ name: string; file?: string }> = {
  name: 'skill_view',
  toolset: 'skills',
  risk: 'read',
  parallelSafe: true,
  description: 'Load a skill\'s full instructions (SKILL.md) — do this BEFORE starting a task a skill covers. Use file to read bundled resources/scripts listed by the skill.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'] },
  summarize: (i) => `Load skill ${i.name}${i.file ? `/${i.file}` : ''}`,
  async execute(input, ctx) {
    const { info, content } = ctx.runtime.skills.read(input.name, input.file);
    ctx.agent.noteSkillUse(info.name);
    return { content: input.file ? content : `# Skill: ${info.name} (v${info.version ?? '1'})\n\n${content}` };
  },
};

export const skillManageTool: ToolDefinition<{
  action: 'create' | 'update' | 'patch' | 'delete' | 'install';
  name?: string;
  description?: string;
  body?: string;
  category?: string;
  tags?: string[];
  old_text?: string;
  new_text?: string;
  files?: Record<string, string>;
  source?: string;
}> = {
  name: 'skill_manage',
  toolset: 'skills',
  risk: (i) => (i.action === 'install' ? 'external' : 'read'),
  description:
    'Create and improve skills — your procedural memory. After finishing a complex or novel task, capture the reusable procedure as a skill ' +
    '(create{name, description, body, category, files?}). When a skill was wrong or incomplete, fix it (patch{name, old_text, new_text} or update{name, body}). ' +
    'install{source} pulls skills from a git URL or "owner/repo/path". delete removes a user skill. A good skill states when to use it, the exact steps, pitfalls and verification.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'patch', 'delete', 'install'] },
      name: { type: 'string' },
      description: { type: 'string', description: 'One-line description: what it does and when to use it.' },
      body: { type: 'string', description: 'Markdown instructions (SKILL.md body).' },
      category: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra resource files {relative/path: content}.' },
      source: { type: 'string' },
    },
    required: ['action'],
  },
  summarize: (i) => `${i.action} skill ${i.name ?? i.source ?? ''}`,
  async execute(input, ctx) {
    const reg = ctx.runtime.skills;
    switch (input.action) {
      case 'create': {
        if (!input.name || !input.description || !input.body) return { content: 'create needs name, description and body', isError: true };
        const s = reg.create({ name: input.name, description: input.description, body: input.body, category: input.category, tags: input.tags, files: input.files });
        return { content: `Created skill "${s.name}" at ${s.path}. It will appear in the skills index of new sessions.` };
      }
      case 'update': {
        if (!input.name) return { content: 'name is required', isError: true };
        const s = reg.update(input.name, { description: input.description, body: input.body, files: input.files });
        return { content: `Updated skill "${s.name}" → v${s.version}.` };
      }
      case 'patch': {
        if (!input.name || !input.old_text || input.new_text === undefined) return { content: 'patch needs name, old_text and new_text', isError: true };
        const s = reg.patch(input.name, input.old_text, input.new_text);
        return { content: `Patched skill "${s.name}" → v${s.version}.` };
      }
      case 'delete':
        if (!input.name) return { content: 'name is required', isError: true };
        reg.delete(input.name);
        return { content: `Deleted skill "${input.name}".` };
      case 'install': {
        if (!input.source) return { content: 'source is required', isError: true };
        const list = await reg.install(input.source, { category: input.category });
        return { content: `Installed ${list.length} skill(s): ${list.map((s) => s.name).join(', ')}` };
      }
      default:
        return { content: 'unknown action', isError: true };
    }
  },
};

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export const cronCreateTool: ToolDefinition<{ name?: string; schedule: string; prompt: string; deliver_to?: string; model?: string; skills?: string[] }> = {
  name: 'cron_create',
  toolset: 'cron',
  risk: 'external',
  description:
    'Schedule an autonomous task. schedule accepts cron ("0 9 * * 1-5") or English ("every 30 minutes", "every day at 9am", "weekdays at 18:00", ' +
    '"every monday at 8", "in 2 hours", ISO time). prompt is a complete standalone instruction (the run starts with no conversation context). ' +
    'deliver_to: "telegram:<chat>", "discord:<channel>", "slack:<channel>", "matrix:<room>", "webhook:<url>" or omit to keep results in Kronos.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      schedule: { type: 'string' },
      prompt: { type: 'string' },
      deliver_to: { type: 'string' },
      model: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Skills to preload for each run.' },
    },
    required: ['schedule', 'prompt'],
  },
  summarize: (i) => `Schedule "${truncate(i.name ?? i.prompt, 40)}" (${i.schedule})`,
  async execute(input, ctx) {
    const job = ctx.runtime.cron.create({
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      model: input.model,
      skills: input.skills,
      cwd: ctx.cwd,
      deliver: input.deliver_to ? { target: input.deliver_to } : undefined,
    });
    return {
      content: `Scheduled "${job.name}" (${job.description}). Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'n/a'}. Id: ${job.id}.`,
      meta: { jobId: job.id },
    };
  },
};

export const cronListTool: ToolDefinition<Record<string, never>> = {
  name: 'cron_list',
  toolset: 'cron',
  risk: 'read',
  parallelSafe: true,
  description: 'List scheduled automations with their status and next run time.',
  parameters: { type: 'object', properties: {} },
  summarize: () => 'List automations',
  async execute(_input, ctx) {
    const jobs = ctx.runtime.cron.list();
    if (!jobs.length) return { content: 'No scheduled automations.' };
    return {
      content: jobs
        .map(
          (j) =>
            `${j.id}  ${j.enabled ? '●' : '○'} ${j.name} — ${j.description}; next: ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—'}; last: ${j.lastStatus ?? 'never'}${j.deliver?.target ? `; → ${j.deliver.target}` : ''}`,
        )
        .join('\n'),
    };
  },
};

export const cronUpdateTool: ToolDefinition<{ id: string; action: 'pause' | 'resume' | 'run' | 'delete' | 'edit'; schedule?: string; prompt?: string; name?: string; deliver_to?: string }> = {
  name: 'cron_update',
  toolset: 'cron',
  risk: (i) => (i.action === 'pause' ? 'read' : 'external'),
  description: 'Manage an automation: pause, resume, run (now), delete, or edit {schedule, prompt, name, deliver_to}.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job id or name.' },
      action: { type: 'string', enum: ['pause', 'resume', 'run', 'delete', 'edit'] },
      schedule: { type: 'string' },
      prompt: { type: 'string' },
      name: { type: 'string' },
      deliver_to: { type: 'string' },
    },
    required: ['id', 'action'],
  },
  summarize: (i) => `${i.action} automation ${i.id}`,
  async execute(input, ctx) {
    const cron = ctx.runtime.cron;
    const job = cron.get(input.id);
    if (!job) return { content: `No automation "${input.id}"`, isError: true };
    switch (input.action) {
      case 'pause':
        cron.update(job.id, { enabled: false });
        return { content: `Paused "${job.name}".` };
      case 'resume':
        cron.update(job.id, { enabled: true });
        return { content: `Resumed "${job.name}".` };
      case 'delete':
        cron.remove(job.id);
        return { content: `Deleted "${job.name}".` };
      case 'run': {
        const r = await cron.run(job.id);
        return { content: `Run ${r.status}:\n${truncate(r.output, 4000)}`, isError: r.status === 'error' };
      }
      case 'edit': {
        const j = cron.update(job.id, { schedule: input.schedule, prompt: input.prompt, name: input.name, deliver: input.deliver_to ? { target: input.deliver_to } : undefined });
        return { content: `Updated "${j.name}" (${j.description}).` };
      }
      default:
        return { content: 'unknown action', isError: true };
    }
  },
};

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const generateImageTool: ToolDefinition<{ prompt: string; size?: string; filename?: string }> = {
  name: 'generate_image',
  toolset: 'image',
  risk: 'network',
  description: 'Generate an image from a text prompt (OpenAI gpt-image, fal.ai Flux or Replicate; offline fallback renders a procedural pixel-art image). The image is saved as an artifact and shown to the user.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed visual description: subject, style, composition, lighting, palette.' },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
      filename: { type: 'string' },
    },
    required: ['prompt'],
  },
  summarize: (i) => `Generate image: ${truncate(i.prompt, 60)}`,
  async execute(input, ctx) {
    const img = await generateImage(input.prompt, ctx.runtime.config.image, ctx.runtime.paths.outputs, { size: input.size, filename: input.filename, signal: ctx.signal });
    const art = ctx.runtime.artifacts.add({ kind: 'image', title: basename(img.path), location: img.path, sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
    const status = imageProviderStatus(ctx.runtime.config.image);
    return {
      content: `Generated image saved to ${img.path} (${img.provider}${status.reason && img.provider === 'procedural' ? ` — ${status.reason}` : ''}).${img.revisedPrompt ? `\nRevised prompt: ${img.revisedPrompt}` : ''}`,
      images: [{ type: 'image', mediaType: img.mediaType, data: img.data.toString('base64'), name: basename(img.path) }],
      meta: { path: img.path, artifacts: [{ kind: 'image', title: art.title, location: img.path }] },
    };
  },
};

const IMG_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export const viewImageTool: ToolDefinition<{ source: string }> = {
  name: 'view_image',
  toolset: 'vision',
  risk: 'read',
  parallelSafe: true,
  description: 'Look at an image file or image URL (screenshots, diagrams, photos, charts). Requires a vision-capable model.',
  parameters: { type: 'object', properties: { source: { type: 'string', description: 'File path or http(s) URL.' } }, required: ['source'] },
  summarize: (i) => `View image ${truncate(i.source, 60)}`,
  async execute(input, ctx) {
    let data: Buffer;
    let mediaType = 'image/png';
    if (/^https?:\/\//.test(input.source)) {
      const res = await fetch(input.source, { signal: ctx.signal });
      if (!res.ok) return { content: `HTTP ${res.status}`, isError: true };
      mediaType = (res.headers.get('content-type') ?? 'image/png').split(';')[0] as string;
      data = Buffer.from(await res.arrayBuffer());
    } else {
      const p = resolvePath(input.source, ctx.cwd);
      if (!existsSync(p)) return { content: `Not found: ${input.source}`, isError: true };
      if (statSync(p).size > 15_000_000) return { content: 'Image too large (>15MB)', isError: true };
      mediaType = IMG_EXT[extname(p).toLowerCase()] ?? 'image/png';
      data = readFileSync(p);
    }
    return { content: `Image ${input.source} (${mediaType}, ${(data.length / 1024).toFixed(0)} KB)`, images: [{ type: 'image', mediaType, data: data.toString('base64') }] };
  },
};

export const ttsTool: ToolDefinition<{ text: string; voice?: string }> = {
  name: 'text_to_speech',
  toolset: 'voice',
  risk: 'network',
  description: 'Turn text into spoken audio (mp3) saved as an artifact — for voice replies, narration or audio summaries.',
  parameters: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' } }, required: ['text'] },
  available: () => (process.env.OPENAI_API_KEY || process.env.ELEVENLABS_API_KEY ? null : 'needs OPENAI_API_KEY or ELEVENLABS_API_KEY'),
  summarize: (i) => `Speak: ${truncate(i.text, 50)}`,
  async execute(input, ctx) {
    const r = await textToSpeech(input.text, ctx.runtime.config.voice, ctx.runtime.paths.outputs, { voice: input.voice, signal: ctx.signal });
    ctx.runtime.artifacts.add({ kind: 'file', title: basename(r.path), location: r.path, sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
    return { content: `Audio saved to ${r.path} (${r.provider}).`, meta: { path: r.path, audio: true } };
  },
};

// ---------------------------------------------------------------------------
// Artifacts & messaging
// ---------------------------------------------------------------------------

export const artifactTool: ToolDefinition<{ title: string; location: string; kind?: 'file' | 'image' | 'link' }> = {
  name: 'artifact_create',
  toolset: 'artifacts',
  risk: 'read',
  description: 'Register a deliverable (file path, image or URL) in the Artifacts library so the user can find it later. Files you write are registered automatically.',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, location: { type: 'string' }, kind: { type: 'string', enum: ['file', 'image', 'link'] } },
    required: ['title', 'location'],
  },
  summarize: (i) => `Save artifact ${i.title}`,
  async execute(input, ctx) {
    const kind = input.kind ?? (/^https?:/.test(input.location) ? 'link' : IMG_EXT[extname(input.location).toLowerCase()] ? 'image' : 'file');
    const location = kind === 'link' ? input.location : resolvePath(input.location, ctx.cwd);
    const a = ctx.runtime.artifacts.add({ kind, title: input.title, location, sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
    return { content: `Saved artifact "${a.title}" (${a.kind}).`, meta: { artifacts: [{ kind, title: a.title, location }] } };
  },
};

export const sendMessageTool: ToolDefinition<{ to: string; text: string }> = {
  name: 'send_message',
  toolset: 'messaging',
  risk: 'external',
  description: `Send a message to a chat platform. to = "<platform>:<target>" where platform is one of ${Object.keys(PLATFORM_LABELS).join(', ')} (e.g. "telegram:123456", "discord:<channel id>", "slack:C0123", "webhook:https://…"). Use "home" as the target for the platform's configured home chat.`,
  parameters: {
    type: 'object',
    properties: { to: { type: 'string' }, text: { type: 'string', description: 'Markdown text.' } },
    required: ['to', 'text'],
  },
  summarize: (i) => `Message ${i.to}`,
  async execute(input, ctx) {
    const idx = input.to.indexOf(':');
    const platform = (idx > 0 ? input.to.slice(0, idx) : input.to) as PlatformId;
    const target = idx > 0 ? input.to.slice(idx + 1) : 'home';
    if (!PLATFORM_LABELS[platform]) return { content: `Unknown platform "${platform}"`, isError: true };
    await ctx.runtime.sendMessage(platform, target, input.text);
    return { content: `Sent to ${PLATFORM_LABELS[platform]} (${target}).`, meta: { messageId: newId('m_') } };
  },
};

export const agenticTools = [
  memoryTool,
  sessionSearchTool,
  todoTool,
  askUserTool,
  exitPlanModeTool,
  delegateTool,
  skillsListTool,
  skillViewTool,
  skillManageTool,
  cronCreateTool,
  cronListTool,
  cronUpdateTool,
  generateImageTool,
  viewImageTool,
  ttsTool,
  artifactTool,
  sendMessageTool,
] as ToolDefinition[];
