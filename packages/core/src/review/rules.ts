import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseFrontmatter } from '../util/frontmatter.js';
import { matchGlob } from '../util/glob.js';
import { truncate } from '../util/text.js';

/**
 * Per-language checklists of the defects worth a reviewer's time. They name failure patterns,
 * not style preferences: a finding has to be something the author would fix.
 */
interface Checklist {
  name: string;
  match: (path: string) => boolean;
  items: string[];
}

const ext = (...e: string[]) => (p: string) => e.includes(extname(p).toLowerCase());
const file = (...names: string[]) => (p: string) => names.includes(basename(p));

const CHECKLISTS: Checklist[] = [
  {
    name: 'TypeScript / JavaScript',
    match: ext('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'),
    items: [
      'Promises that are not awaited or returned (lost errors, races); `forEach` with async callbacks; missing `try/finally` cleanup around awaits',
      '`==` coercion bugs, `||` used where `??` is meant (0, "" and false are valid values), optional chaining that hides a required value',
      'Array/object mutation of shared or frozen state; `sort()`/`reverse()` mutating the caller\'s array; stale closures over loop variables',
      'React: hooks called conditionally, missing/incorrect effect dependencies, effects without cleanup (listeners, timers, subscriptions), state updated after unmount, keys from array indexes in reordered lists',
      'Untrusted input reaching `innerHTML`/`dangerouslySetInnerHTML`, `eval`/`new Function`, shell commands, file paths (path traversal) or SQL strings',
      'Type assertions (`as`, `!`) that hide a real `undefined`; `JSON.parse` without validation at trust boundaries',
      'Unbounded caches, listeners never removed, intervals never cleared; O(n²) work on hot paths',
      'Node: sync fs/crypto calls on request paths, unhandled stream errors, missing `signal`/timeouts on network calls',
    ],
  },
  {
    name: 'Python',
    match: ext('.py', '.pyi'),
    items: [
      'Mutable default arguments; late-binding closures in loops; shadowed builtins that change behavior',
      'Bare `except:` / `except Exception: pass` swallowing errors; exceptions re-raised without context',
      'Files, sockets, locks or DB connections opened without `with`; generators left unclosed',
      'Blocking calls inside `async def`; `asyncio` tasks created and never awaited or stored',
      'SQL built with f-strings or `%`; `subprocess` with `shell=True` on untrusted input; `pickle`/`yaml.load` on untrusted data; path traversal',
      'Integer/float division mistakes, off-by-one slicing, `is` used for value comparison',
      'Changed public function signatures or return types without updating callers',
    ],
  },
  {
    name: 'Go',
    match: ext('.go'),
    items: [
      'Errors ignored (`_ =`) or shadowed by `:=` in an inner scope; `err` checked on the wrong variable',
      'Goroutine leaks (blocked sends, missing `ctx.Done()`), data races on maps/slices shared between goroutines, `sync.WaitGroup.Add` inside the goroutine',
      '`defer` inside loops (resource exhaustion), `defer resp.Body.Close()` missing or before the error check',
      'Loop variable captured by goroutines/closures (pre-1.22 semantics), slices aliasing the same backing array after `append`',
      'nil map writes, nil pointer dereference on error paths, typed-nil interfaces compared with nil',
      'Context not propagated; `time.After` in loops; unbounded channels or buffers',
    ],
  },
  {
    name: 'Rust',
    match: ext('.rs'),
    items: [
      '`unwrap`/`expect`/indexing that can panic on input-controlled data; integer overflow in release builds (`as` casts truncating)',
      '`unsafe` blocks: aliasing, lifetime and alignment invariants actually upheld; `Send`/`Sync` impls justified',
      'Blocking calls (std fs/net, `Mutex` held across `.await`) inside async code; locks held too long or acquired in inconsistent order',
      'Errors converted to strings or discarded (`let _ =`) where the caller needs them; `?` changing error semantics',
      'Unbounded `Vec`/`String` growth from external input; needless clones of large data on hot paths',
    ],
  },
  {
    name: 'Java / Kotlin / Scala',
    match: ext('.java', '.kt', '.kts', '.scala', '.groovy'),
    items: [
      'Resources not closed (use try-with-resources / `use {}`); streams and connections leaked on exception paths',
      'Null handling: platform types in Kotlin, `Optional.get()` without check, autounboxing of null',
      '`equals`/`hashCode` contracts broken; mutable objects used as map keys; `==` on boxed values or strings (Java)',
      'Thread safety: non-thread-safe collections or `SimpleDateFormat` shared across threads, double-checked locking without `volatile`, coroutine scope leaks',
      'SQL/JPQL concatenation, deserialization of untrusted data, XML parsers without XXE protection',
      'Swallowed `InterruptedException`; catching `Throwable`/`Exception` and continuing in a broken state',
    ],
  },
  {
    name: 'C / C++ / Objective-C',
    match: ext('.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm', '.cu'),
    items: [
      'Buffer overflows, off-by-one in bounds, unchecked `memcpy`/`strcpy`/`sprintf` sizes, missing NUL termination',
      'Use-after-free, double free, dangling references to temporaries, iterator invalidation after container mutation',
      'Leaks on error paths; ownership unclear (raw `new`/`malloc` without RAII); exceptions escaping destructors',
      'Integer overflow/underflow and signed/unsigned comparison bugs in sizes and indexes; uninitialized variables',
      'Data races, missing locks, lock-order inversions; non-atomic flags shared between threads',
      'Undefined behavior: strict aliasing, shifts by width, null dereference, unsequenced modifications',
      'ABI or header changes that break existing callers (linkage, struct layout, default arguments)',
    ],
  },
  {
    name: 'C# / F#',
    match: ext('.cs', '.fs', '.fsx', '.vb'),
    items: [
      '`IDisposable` not disposed; `async void` outside event handlers; `.Result`/`.Wait()` deadlocks',
      'Null reference risks despite nullable annotations; LINQ multiple enumeration of expensive sequences',
      'SQL concatenation, unsafe deserialization (`BinaryFormatter`), path traversal',
      'Thread-unsafe statics, `lock` on `this` or strings',
    ],
  },
  {
    name: 'Swift',
    match: ext('.swift'),
    items: [
      'Force unwraps/`try!`/`as!` on values that can be nil or fail; retain cycles in closures (missing `[weak self]`)',
      'UI updated off the main actor; data races across actors/tasks; `Task` not cancelled',
      'Keychain/secrets stored in UserDefaults; ATS exceptions',
    ],
  },
  {
    name: 'Ruby',
    match: ext('.rb', '.rake', '.erb'),
    items: [
      'SQL interpolation in `where`/`find_by_sql`, `send`/`constantize` on user input, mass assignment without strong params',
      'N+1 queries; callbacks with side effects; `rescue => e` swallowing errors',
      'Mutable constants and class-level state shared across requests/threads',
    ],
  },
  {
    name: 'PHP',
    match: ext('.php', '.phtml'),
    items: [
      'SQL injection (string-built queries), XSS (unescaped output), file inclusion from user input, `unserialize` on untrusted data',
      'Loose comparisons (`==`) on hashes/tokens; missing CSRF protection on state-changing routes',
      'Errors suppressed with `@`; unchecked return values of IO functions',
    ],
  },
  {
    name: 'Shell',
    match: (p) => ext('.sh', '.bash', '.zsh', '.ksh')(p) || basename(p) === 'Makefile',
    items: [
      'Unquoted variables and command substitutions (word splitting, globbing), `rm -rf "$VAR/"` with a possibly empty variable',
      'Missing `set -euo pipefail` where failures must stop the script; pipelines hiding errors',
      'Temporary files in predictable paths; `eval` or unvalidated input in commands; secrets echoed into logs',
    ],
  },
  {
    name: 'SQL / migrations',
    match: ext('.sql', '.prisma'),
    items: [
      'Migrations that lock or rewrite large tables, drop columns still in use, or are not reversible',
      'Missing indexes for new foreign keys or new query patterns; NOT NULL columns added without defaults to existing tables',
      'Data-destroying statements without a WHERE clause; collation/encoding changes',
    ],
  },
  {
    name: 'GitHub Actions',
    match: (p) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p),
    items: [
      '`pull_request_target` or `workflow_run` that checks out and runs untrusted PR code with secrets or write tokens',
      '`${{ github.event.* }}` (titles, bodies, branch names) interpolated directly into `run:` scripts — script injection',
      'Missing or overly broad `permissions:`; secrets printed or passed to untrusted steps; third-party actions not pinned to a SHA',
      'Steps that always succeed (`|| true`, `continue-on-error`) hiding failures; caches keyed so they never invalidate',
    ],
  },
  {
    name: 'Docker',
    match: (p) => /(^|\/)(Dockerfile|Containerfile)[^/]*$/.test(p) || /docker-compose[^/]*\.ya?ml$/.test(p),
    items: [
      'Secrets copied into layers or passed as build args; running as root without need',
      'Unpinned base images; `apt-get install` without `--no-install-recommends` and cache cleanup inflating images',
      'Ports or volumes exposing more than intended; healthchecks that never fail',
    ],
  },
  {
    name: 'Kubernetes / Helm / Terraform',
    match: (p) => ext('.tf', '.tfvars', '.hcl', '.bicep')(p) || /(^|\/)(k8s|kubernetes|helm|charts|manifests|deploy)\/.*\.ya?ml$/.test(p),
    items: [
      'Public exposure (0.0.0.0/0, public buckets, privileged pods, hostNetwork); wildcard IAM permissions',
      'Resources that will be destroyed and recreated by the change (renames, immutable fields) causing downtime or data loss',
      'Missing resource limits, probes or encryption at rest; secrets in plain values',
    ],
  },
  {
    name: 'Package manifests',
    match: file('package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json'),
    items: [
      'New dependencies that are unmaintained, typo-squatted, duplicated, or far heavier than the need',
      'Version ranges that allow breaking majors; runtime dependencies placed in dev dependencies or the reverse',
      'Scripts that run on install (`postinstall`) or fetch remote code; engine/runtime constraints changed without reason',
    ],
  },
  {
    name: 'Config / data files',
    match: ext('.json', '.yaml', '.yml', '.toml', '.ini', '.properties', '.env.example', '.xml'),
    items: [
      'Keys renamed or removed while code still reads the old names; type changes (string vs number vs boolean)',
      'Credentials, internal hostnames or personal data committed; production values in development config',
    ],
  },
  {
    name: 'Solidity / smart contracts',
    match: ext('.sol', '.vy'),
    items: [
      'Reentrancy (external calls before state updates), unchecked return values of low-level calls',
      'Access control missing on privileged functions; `tx.origin` authentication; front-running sensitive operations',
      'Integer precision loss in divisions; unbounded loops over user-controlled arrays',
    ],
  },
  {
    name: 'HTML / CSS / templates',
    match: ext('.html', '.htm', '.css', '.scss', '.sass', '.less', '.hbs', '.mustache', '.jinja', '.j2', '.twig', '.pug', '.ejs'),
    items: [
      'Unescaped user content in templates (XSS); `target="_blank"` links to untrusted sites without `rel="noopener"`',
      'Forms or interactive elements without labels or keyboard access; layout broken at narrow widths',
    ],
  },
  {
    name: 'Dart / Flutter',
    match: ext('.dart'),
    items: ['`setState` after `dispose`, controllers and streams not disposed, `BuildContext` used across async gaps', 'Null-assertion `!` on values that can be null'],
  },
  {
    name: 'Elixir / Erlang',
    match: ext('.ex', '.exs', '.erl'),
    items: ['Processes without supervision, unbounded mailboxes, atoms created from user input', 'Pattern matches that crash on unexpected input at trust boundaries'],
  },
  {
    name: 'Haskell / OCaml / Elm',
    match: ext('.hs', '.ml', '.mli', '.elm'),
    items: ['Partial functions (`head`, `fromJust`, `List.hd`) on possibly empty data; space leaks from lazy accumulation', 'Exceptions escaping pure code paths'],
  },
  {
    name: 'Lua / Zig / Nim / Julia / R',
    match: ext('.lua', '.zig', '.nim', '.jl', '.r'),
    items: ['Global variables created by accident; off-by-one with 1-based indexing', 'Allocations without matching frees (Zig `defer`/`errdefer` missing)'],
  },
  {
    name: 'Protobuf / GraphQL / OpenAPI',
    match: (p) => ext('.proto', '.graphql', '.gql', '.thrift', '.capnp')(p) || /openapi|swagger/i.test(basename(p)),
    items: [
      'Wire-incompatible changes: reused or renumbered field tags, changed types, removed fields or enum values still sent by clients',
      'Fields made required that old clients do not send; breaking renames without deprecation',
    ],
  },
];

/** Checks that apply to every file, whatever the language. */
export const GENERAL_CHECKS = [
  'Logic errors: inverted conditions, wrong operator, off-by-one, wrong variable, unreachable or dead branches introduced by the change',
  'Behavior changes the author may not intend: changed defaults, return values, error types, ordering, units, public API or wire/storage formats',
  'Error handling: failures ignored, partial updates left behind, retries without limits, misleading messages',
  'Security: injection (SQL, shell, path, template), missing authorization/authentication checks, secrets in code or logs, unsafe deserialization, SSRF',
  'Concurrency and resources: races, deadlocks, leaks of files/handles/memory/goroutines/listeners, unbounded growth',
  'Edge cases: empty/null/zero/negative/huge input, unicode, time zones, concurrent callers',
  'Callers and tests: code that calls a changed function must still work; tests that no longer test what they claim',
];

export function checklistsFor(paths: string[]): { name: string; items: string[] }[] {
  const out: { name: string; items: string[] }[] = [];
  for (const c of CHECKLISTS) if (paths.some((p) => c.match(p))) out.push({ name: c.name, items: c.items });
  return out;
}

export interface ProjectRule {
  source: string;
  /** globs the rule applies to; empty = every file */
  paths: string[];
  text: string;
}

const ROOT_RULE_FILES = ['REVIEW.md', '.kronos/review.md', '.github/REVIEW.md', 'docs/REVIEW.md'];
/** project instruction files whose review-related sections also count (AGENTS.md, CLAUDE.md, …) */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'KRONOS.md', '.github/copilot-instructions.md'];

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Sections of an instructions file that talk about review, code style or conventions. */
function reviewSections(md: string): string {
  const parts = md.split(/^(?=#{1,3} )/m);
  const keep = parts.filter((p) => /^#{1,3} .*(review|convention|guideline|rule|standard|style|must|never|do not|security)/i.test(p));
  return keep.join('\n').trim();
}

/**
 * Project review rules, most general first: REVIEW.md (or .kronos/review.md), review sections of
 * AGENTS.md/CLAUDE.md, and path-scoped rule files in `.kronos/review/*.md` with
 * `paths: ["src/api/**"]` front matter.
 */
export function loadProjectRules(root: string): ProjectRule[] {
  const rules: ProjectRule[] = [];
  for (const f of ROOT_RULE_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const { data, body } = parseFrontmatter<{ paths?: unknown }>(readFileSync(p, 'utf8'));
    if (body.trim()) rules.push({ source: f, paths: asList(data.paths), text: truncate(body.trim(), 12_000) });
  }
  for (const f of INSTRUCTION_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const sections = reviewSections(readFileSync(p, 'utf8'));
    if (sections) rules.push({ source: f, paths: [], text: truncate(sections, 6000) });
  }
  const dir = join(root, '.kronos', 'review');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      const { data, body } = parseFrontmatter<{ paths?: unknown }>(readFileSync(join(dir, name), 'utf8'));
      if (body.trim()) rules.push({ source: `.kronos/review/${name}`, paths: asList(data.paths), text: truncate(body.trim(), 8000) });
    }
  }
  return rules;
}

export function rulesFor(rules: ProjectRule[], paths: string[]): ProjectRule[] {
  return rules.filter((r) => !r.paths.length || paths.some((p) => r.paths.some((g) => matchGlob(p, g))));
}
