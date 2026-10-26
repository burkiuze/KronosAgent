import type { EffortSetting, PermissionMode } from '../types.js';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** extra headers sent with every request */
  headers?: Record<string, string>;
  /** default models to show in pickers (custom providers) */
  models?: string[];
  enabled?: boolean;
  /** Anthropic: use server-side refusal fallbacks when the model supports them */
  serverFallbacks?: boolean;
  /** Anthropic: ask the API to drop (not reject) thinking blocks whose prefix changed */
  dropMismatchedThinking?: boolean;
  /** Anthropic: prompt caching (on by default) */
  promptCaching?: boolean;
  /** OpenAI-compatible: label shown in UI */
  label?: string;
}

export interface CustomProviderConfig extends ProviderConfig {
  id: string;
  label?: string;
  baseUrl: string;
  /** api dialect, defaults to openai */
  api?: 'openai' | 'anthropic';
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  /** only expose these tools (glob patterns) */
  include?: string[];
  exclude?: string[];
}

export interface HookConfig {
  /** tool name glob (e.g. "shell", "write_*", "*") */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface PlatformConfigBase {
  enabled?: boolean;
  /** user ids allowed to talk to the agent; empty = pairing required */
  allowedUsers?: string[];
  /** default chat for deliveries (cron, notifications) */
  homeChat?: string;
  /** permission mode for agent runs started from this platform */
  mode?: PermissionMode;
}

export interface KronosConfig {
  model: {
    default: string;
    fallbacks: string[];
    effort: EffortSetting;
    thinking: boolean;
    showThinking: boolean;
    maxOutputTokens: number;
    temperature?: number | null;
    subagent?: string | null;
    summary?: string | null;
    vision?: string | null;
    /**
     * how tools reach the model: 'native' function calling, 'text' (tools described in the prompt,
     * calls written as text — for models without function calling), or 'auto': native, switching
     * a model to text when its provider says it cannot take tools
     */
    toolMode: 'auto' | 'native' | 'text';
  };
  providers: Record<string, ProviderConfig>;
  customProviders: CustomProviderConfig[];
  agent: {
    name: string;
    maxIterations: number;
    parallelTools: boolean;
    autoTitle: boolean;
    toolOutputLimit: number;
    instructions: string;
    personality: string;
    language: string;
    /**
     * threshold: share of the context window that triggers it. First the bodies of tool outputs older
     * than the `keepToolResults` most recent are cleared; if that is not enough, everything before the
     * last `keepRecentTurns` user turns is summarized (and archived, still readable and searchable).
     */
    compaction: { enabled: boolean; threshold: number; keepRecentTurns: number; clearToolResults: boolean; keepToolResults: number };
    subagents: { maxConcurrent: number; maxDepth: number; maxIterations: number };
    /**
     * learning: "background" — after a substantial turn (skillAfterToolCalls tool calls) or one with
     * a correction, a separate agent updates memory and skills (Hermes-style); "inline" — remind the
     * agent in the conversation instead; "off"
     */
    nudges: { memoryEvery: number; skillAfterToolCalls: number; learning: 'background' | 'inline' | 'off' };
    /** when a run edited files but never ran verify afterwards, ask for verification once before finishing */
    verifyBeforeFinish: boolean;
    /** parse files right after write/edit/patch and report syntax errors in the same tool result */
    editDiagnostics: boolean;
    /**
     * "auto": also ask an installed language server (typescript-language-server, pyright, gopls,
     * rust-analyzer, clangd) for the errors an edit introduced; servers stop after 5 idle minutes
     */
    lsp: 'auto' | 'off';
    /**
     * lean mode for small models: the core tools only, short tool descriptions and a compact
     * prompt. 'auto' turns it on for context windows up to 32k tokens.
     */
    lean: 'auto' | 'on' | 'off';
    /** per-run limits (0 = unlimited); a run that reaches one stops cleanly and can be continued */
    budget: { maxTokens: number; maxCostUsd: number; maxMinutes: number };
  };
  toolsets: { enabled: string[]; disabled: string[] };
  terminal: {
    backend: 'local' | 'docker' | 'ssh';
    cwd: string;
    timeoutSec: number;
    shell?: string;
    docker: { image: string; workdir: string; extraArgs: string[]; network: boolean };
    ssh: { host: string; user?: string; port?: number; key?: string; workdir?: string };
    /**
     * OS sandbox for the local backend (Landlock on Linux, Seatbelt on macOS): "workspace-write"
     * lets commands change only the project and temp directories, "read-only" only temp
     */
    sandbox: { mode: 'off' | 'workspace-write' | 'read-only'; network: boolean; writable: string[]; fallback: 'refuse' | 'unsandboxed'; allowDomains: string[] };
  };
  safety: {
    mode: PermissionMode;
    allow: string[];
    deny: string[];
    dangerousCommands: 'ask' | 'block' | 'allow';
    workspaceOnly: boolean;
    redactSecrets: boolean;
    checkpoints: boolean;
    protectedPaths: string[];
    /**
     * a second model decides on actions that would need approval: "unattended" when no person can
     * answer (GitHub bot, automations, headless runs), "always" before every prompt, or "off"
     */
    /** refuse to install or run packages with a malware advisory in the OSV database (npm, PyPI) */
    malwareCheck: boolean;
    guardian: { mode: 'off' | 'unattended' | 'always'; model: string | null; /** extra trusted rules for the reviewer */ policy: string };
  };
  memory: {
    enabled: boolean;
    memoryCharLimit: number;
    userCharLimit: number;
    sessionSearch: boolean;
    autoExtract: boolean;
    /** recap idle conversations and keep an index of past work in every new conversation's context */
    recaps: boolean;
  };
  skills: {
    enabled: boolean;
    dirs: string[];
    disabled: string[];
    autoCreate: boolean;
    claudeCompat: boolean;
    /** skill creations/edits the agent may make in one session (keeps self-modification deliberate) */
    editBudget: number;
    /** agent-written skills unused this many days become prune candidates */
    staleAfterDays: number;
  };
  web: {
    search: { provider: 'auto' | 'duckduckgo' | 'brave' | 'tavily' | 'exa' | 'searxng' | 'serper' | 'jina'; apiKey?: string; url?: string };
    fetch: { maxChars: number; userAgent: string };
  };
  browser: { headless: boolean; executablePath?: string; viewport: { width: number; height: number } };
  image: { provider: 'openai' | 'fal' | 'replicate' | 'none'; model: string; size: string };
  voice: {
    stt: 'openai' | 'groq' | 'none';
    sttModel: string;
    tts: 'openai' | 'elevenlabs' | 'browser' | 'none';
    ttsModel: string;
    voice: string;
    autoSpeak: boolean;
  };
  gateway: {
    host: string;
    port: number;
    token: string;
    openaiApi: boolean;
    cors: string[];
    publicUrl: string;
  };
  platforms: {
    telegram: PlatformConfigBase & { token?: string };
    discord: PlatformConfigBase & { token?: string; channels?: string[]; mentionOnly?: boolean };
    slack: PlatformConfigBase & { botToken?: string; appToken?: string };
    matrix: PlatformConfigBase & { homeserver?: string; accessToken?: string; userId?: string };
    whatsapp: PlatformConfigBase & { accessToken?: string; phoneNumberId?: string; verifyToken?: string; appSecret?: string };
    signal: PlatformConfigBase & { apiUrl?: string; number?: string };
    email: PlatformConfigBase & { smtpUrl?: string; from?: string; to?: string };
    webhook: PlatformConfigBase & { secret?: string };
    homeassistant: PlatformConfigBase & { url?: string; token?: string };
  };
  /**
   * deferAfter: with more MCP tools than this, they are not sent to the model up front; it finds
   * and loads the ones it needs with tool_search (Codex-style progressive disclosure). 0 = never defer.
   */
  mcp: { servers: Record<string, McpServerConfig>; deferAfter: number };
  hooks: {
    preToolUse: HookConfig[];
    postToolUse: HookConfig[];
    userPromptSubmit: HookConfig[];
    sessionStart: HookConfig[];
    stop: HookConfig[];
    /** before asking for approval: stdout {"decision":"allow"} approves, exit 2 / {"decision":"deny"} refuses */
    permissionRequest: HookConfig[];
    /** before compaction: stdout is added to the summary instructions */
    preCompact: HookConfig[];
  };
  cron: { enabled: boolean; timezone: string; maxConcurrent: number };
  ui: {
    theme: string;
    mode: 'light' | 'dark' | 'system';
    toolDisplay: 'product' | 'technical';
    fontSize: number;
    sendOnEnter: boolean;
    showTokenUsage: boolean;
    wallpaper: string;
    density: 'comfortable' | 'compact';
  };
  updates: { channel: 'stable' | 'beta'; autoCheck: boolean };
  telemetry: { enabled: boolean };
  github: {
    /** REST API root (GitHub Enterprise: https://ghe.example.com/api/v3) */
    apiUrl: string;
    webUrl: string;
    /** personal access token; empty → the GitHub CLI's (`gh auth token`) */
    token: string;
    /** where repositories are cloned (default <profile>/repos) */
    reposDir: string;
    /** authenticate `git` in the agent's shell for GitHub remotes */
    shellAuth: boolean;
    /**
     * the official, public Kronos GitHub App: "Connect GitHub" signs users in through it (device flow —
     * only its public client id is needed) and links to installing it on their repositories
     */
    officialApp: { slug: string; clientId: string };
    /** answering @mentions on issues and pull requests (needs the Kronos GitHub App and a public URL) */
    bot: {
      enabled: boolean;
      /** the mention that triggers it */
      trigger: string;
      /** author associations allowed to trigger it */
      allowed: string[];
      mode: PermissionMode;
      model: string | null;
      maxMinutes: number;
      /** review every new pull request automatically (inline comments; nothing is changed) */
      autoReview: boolean;
    };
  };
  /** code review (`kronos review`, the code_review tool, "@kronos review" on pull requests) */
  review: {
    /** model for the reviewers (null: the default model) */
    model: string | null;
    /** a second pass that tries to refute every finding and drops the ones it disproves */
    verify: boolean;
    verifyModel: string | null;
    /** findings below this severity are not reported */
    minSeverity: 'critical' | 'high' | 'medium' | 'low';
    /** findings the reviewer itself rates below this confidence (0-1) are not reported */
    minConfidence: number;
    /** related files reviewed together by one reviewer */
    maxFilesPerGroup: number;
    maxGroupLines: number;
    /** files with more changed lines are listed but not reviewed */
    maxFileLines: number;
    /** reviewers running at the same time */
    concurrency: number;
    /** groups with more changed lines first get a short risk plan */
    planThreshold: number;
    maxIterations: number;
    include: string[];
    exclude: string[];
  };
}

export const ALL_TOOLSETS = [
  'files', 'shell', 'web', 'browser', 'code', 'memory', 'sessions', 'todo', 'clarify', 'delegate', 'skills',
  'cron', 'image', 'vision', 'voice', 'artifacts', 'messaging', 'http', 'mcp', 'github', 'review',
] as const;

export function defaultConfig(): KronosConfig {
  return {
    model: {
      default: 'auto',
      fallbacks: [],
      effort: 'medium',
      thinking: true,
      showThinking: true,
      maxOutputTokens: 64000,
      temperature: null,
      subagent: null,
      summary: null,
      vision: null,
      toolMode: 'auto',
    },
    providers: {
      anthropic: { apiKey: '${ANTHROPIC_API_KEY}', serverFallbacks: true, dropMismatchedThinking: true, promptCaching: true },
      openai: { apiKey: '${OPENAI_API_KEY}' },
      openrouter: { apiKey: '${OPENROUTER_API_KEY}' },
      gemini: { apiKey: '${GEMINI_API_KEY}' },
      groq: { apiKey: '${GROQ_API_KEY}' },
      deepseek: { apiKey: '${DEEPSEEK_API_KEY}' },
      mistral: { apiKey: '${MISTRAL_API_KEY}' },
      xai: { apiKey: '${XAI_API_KEY}' },
      nvidia: { apiKey: '${NVIDIA_API_KEY}' },
      together: { apiKey: '${TOGETHER_API_KEY}' },
      fireworks: { apiKey: '${FIREWORKS_API_KEY}' },
      cerebras: { apiKey: '${CEREBRAS_API_KEY}' },
      nous: { apiKey: '${NOUS_API_KEY}' },
      moonshot: { apiKey: '${MOONSHOT_API_KEY}' },
      zai: { apiKey: '${ZAI_API_KEY}' },
      ollama: { baseUrl: '${OLLAMA_HOST:-http://127.0.0.1:11434}' },
      lmstudio: { baseUrl: '${LMSTUDIO_HOST:-http://127.0.0.1:1234}' },
    },
    customProviders: [],
    agent: {
      name: 'Kronos',
      maxIterations: 120,
      parallelTools: true,
      autoTitle: true,
      toolOutputLimit: 40000,
      instructions: '',
      personality: 'default',
      language: 'auto',
      compaction: { enabled: true, threshold: 0.8, keepRecentTurns: 2, clearToolResults: true, keepToolResults: 8 },
      subagents: { maxConcurrent: 4, maxDepth: 2, maxIterations: 60 },
      nudges: { memoryEvery: 12, skillAfterToolCalls: 18, learning: 'background' },
      verifyBeforeFinish: true,
      editDiagnostics: true,
      lsp: 'off',
      lean: 'auto',
      budget: { maxTokens: 0, maxCostUsd: 0, maxMinutes: 0 },
    },
    toolsets: { enabled: [...ALL_TOOLSETS], disabled: [] },
    terminal: {
      backend: 'local',
      cwd: '',
      timeoutSec: 180,
      docker: { image: 'node:22-bookworm', workdir: '/workspace', extraArgs: [], network: true },
      ssh: { host: '' },
      sandbox: { mode: 'off', network: true, writable: [], fallback: 'refuse', allowDomains: [] },
    },
    safety: {
      mode: 'ask',
      allow: [],
      deny: [],
      dangerousCommands: 'ask',
      workspaceOnly: false,
      redactSecrets: true,
      checkpoints: true,
      protectedPaths: ['~/.ssh/**', '~/.aws/credentials', '~/.kronos/.env', '~/.kronos/github-app.json', '~/.kronos/profiles/*/github-app.json', '/etc/shadow'],
      malwareCheck: true,
      guardian: { mode: 'unattended', model: null, policy: '' },
    },
    memory: { enabled: true, memoryCharLimit: 4000, userCharLimit: 2500, sessionSearch: true, autoExtract: false, recaps: false },
    skills: { enabled: true, dirs: [], disabled: [], autoCreate: true, claudeCompat: true, editBudget: 3, staleAfterDays: 60 },
    web: {
      search: { provider: 'auto' },
      fetch: { maxChars: 60000, userAgent: 'Mozilla/5.0 (compatible; KronosAgent/1.0; +https://github.com/burkiuze/KronosAgent)' },
    },
    browser: { headless: true, viewport: { width: 1280, height: 800 } },
    image: { provider: 'openai', model: 'gpt-image-1', size: '1024x1024' },
    voice: { stt: 'openai', sttModel: 'whisper-1', tts: 'browser', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy', autoSpeak: false },
    gateway: { host: '127.0.0.1', port: 7777, token: '${KRONOS_GATEWAY_TOKEN}', openaiApi: true, cors: [], publicUrl: '' },
    platforms: {
      telegram: { enabled: false, token: '${TELEGRAM_BOT_TOKEN}', allowedUsers: [] },
      discord: { enabled: false, token: '${DISCORD_BOT_TOKEN}', allowedUsers: [], mentionOnly: true },
      slack: { enabled: false, botToken: '${SLACK_BOT_TOKEN}', appToken: '${SLACK_APP_TOKEN}', allowedUsers: [] },
      matrix: { enabled: false, homeserver: '', accessToken: '${MATRIX_ACCESS_TOKEN}', userId: '', allowedUsers: [] },
      whatsapp: { enabled: false, accessToken: '${WHATSAPP_ACCESS_TOKEN}', phoneNumberId: '', verifyToken: '${WHATSAPP_VERIFY_TOKEN}', appSecret: '${WHATSAPP_APP_SECRET}', allowedUsers: [] },
      signal: { enabled: false, apiUrl: 'http://127.0.0.1:8080', number: '', allowedUsers: [] },
      email: { enabled: false, smtpUrl: '${SMTP_URL}', from: '', to: '' },
      webhook: { enabled: false, secret: '${KRONOS_WEBHOOK_SECRET}' },
      homeassistant: { enabled: false, url: '', token: '${HASS_TOKEN}' },
    },
    mcp: { servers: {}, deferAfter: 30 },
    hooks: { preToolUse: [], postToolUse: [], userPromptSubmit: [], sessionStart: [], stop: [], permissionRequest: [], preCompact: [] },
    cron: { enabled: true, timezone: '', maxConcurrent: 2 },
    ui: {
      theme: 'kronos',
      mode: 'system',
      toolDisplay: 'product',
      fontSize: 14,
      sendOnEnter: true,
      showTokenUsage: true,
      wallpaper: 'aurora',
      density: 'comfortable',
    },
    updates: { channel: 'stable', autoCheck: true },
    telemetry: { enabled: false },
    github: {
      apiUrl: 'https://api.github.com',
      webUrl: 'https://github.com',
      token: '${GITHUB_TOKEN}',
      reposDir: '',
      shellAuth: true,
      officialApp: { slug: '', clientId: '' },
      bot: { enabled: true, trigger: '@kronos', allowed: ['OWNER', 'MEMBER', 'COLLABORATOR'], mode: 'yolo', model: null, maxMinutes: 30, autoReview: false },
    },
    review: {
      model: null,
      verify: true,
      verifyModel: null,
      minSeverity: 'low',
      minConfidence: 0.3,
      maxFilesPerGroup: 8,
      maxGroupLines: 1500,
      maxFileLines: 3000,
      concurrency: 3,
      planThreshold: 300,
      maxIterations: 40,
      include: [],
      exclude: [],
    },
  };
}

/** Settings sections used by every UI (desktop settings modal, CLI `config` help). */
export const CONFIG_SECTIONS: { id: string; title: string; keys: string[]; description: string }[] = [
  { id: 'model', title: 'Model', keys: ['model'], description: 'Default model, fallbacks, reasoning effort and thinking.' },
  { id: 'chat', title: 'Chat', keys: ['agent'], description: 'Agent name, personality, instructions, iteration limits, compaction.' },
  { id: 'appearance', title: 'Appearance', keys: ['ui'], description: 'Theme, color mode, tool call display and density.' },
  { id: 'workspace', title: 'Workspace', keys: ['terminal'], description: 'Working directory and terminal backend (local, Docker, SSH).' },
  { id: 'safety', title: 'Safety', keys: ['safety'], description: 'Permission mode, allow/deny rules, dangerous command handling, checkpoints.' },
  { id: 'memory', title: 'Memory & Context', keys: ['memory'], description: 'Persistent memory, user profile, session search.' },
  { id: 'voice', title: 'Voice', keys: ['voice'], description: 'Speech-to-text and text-to-speech.' },
  { id: 'advanced', title: 'Advanced', keys: ['web', 'browser', 'image', 'cron', 'updates', 'telemetry'], description: 'Search provider, browser, image generation, cron and updates.' },
  { id: 'gateway', title: 'Gateway', keys: ['gateway', 'platforms'], description: 'Server address, auth token, OpenAI-compatible API, messaging platforms.' },
  { id: 'keys', title: 'API Keys', keys: ['providers', 'customProviders'], description: 'Provider API keys and custom OpenAI-compatible endpoints.' },
  { id: 'tools', title: 'Skills & Tools', keys: ['toolsets', 'skills', 'hooks'], description: 'Enabled toolsets, skills directories and lifecycle hooks.' },
  { id: 'mcp', title: 'MCP', keys: ['mcp'], description: 'Model Context Protocol servers.' },
];
