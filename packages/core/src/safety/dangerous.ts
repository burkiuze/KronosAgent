/** Detection of destructive / irreversible shell commands. */
import { commandsOf, harmlessRedirect } from './shellparse.js';

interface DangerRule {
  re: RegExp;
  why: string;
}

const RULES: DangerRule[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)[a-z-]*\s+(\/|~|\$HOME|\*|\.\.?\/?)(\s|$)/i, why: 'recursive force-delete of a root, home, parent or wildcard path' },
  { re: /\brm\s+-[a-z]*r[a-z]*\s+(\/|~)(\s|$)/i, why: 'recursive delete of / or ~' },
  { re: /\bsudo\s+rm\b/i, why: 'privileged delete' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'formats a filesystem' },
  { re: /\bdd\b[^|]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/i, why: 'raw write to a disk device' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)\w*/i, why: 'redirects output onto a disk device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i, why: 'world-writable root' },
  { re: /\bchown\s+-R\s+\S+\s+\/(\s|$)/i, why: 'recursive chown of /' },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, why: 'pipes a downloaded script straight into a shell' },
  { re: /\bgit\s+push\b[^;&|]*(--force\b|-f\b|--force-with-lease\b)/i, why: 'force-push rewrites remote history' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+clean\s+-[a-z]*d[a-z]*f/i, why: 'deletes untracked files' },
  { re: /\bgit\s+(branch\s+-D|checkout\s+--\s+\.|restore\s+\.)/i, why: 'discards branches or local changes' },
  { re: /\brm\s+-[a-z]*rf?\s+\.git\b/i, why: 'deletes repository history' },
  { re: /\b(drop\s+(database|schema|table)|truncate\s+table)\b/i, why: 'destroys database data' },
  { re: /\bdelete\s+from\s+\w+\s*(;|$)/i, why: 'unbounded DELETE without WHERE' },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, why: 'powers off / restarts the machine' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall\s+-9\b/i, why: 'kills every process' },
  { re: /\biptables\s+-F\b|\bufw\s+disable\b/i, why: 'drops firewall rules' },
  { re: /\bcrontab\s+-r\b/i, why: 'removes all cron jobs' },
  { re: /\bfind\s+\/\S*\s.*-delete\b/i, why: 'mass delete via find' },
  { re: /\bterraform\s+(destroy|apply\s+.*-auto-approve)\b/i, why: 'destroys or changes infrastructure without review' },
  { re: /\bkubectl\s+delete\s+(ns|namespace|--all|all\b)/i, why: 'deletes Kubernetes resources broadly' },
  { re: /\bdocker\s+(system\s+prune\s+-a|rm\s+-f\s+\$\(docker\s+ps)/i, why: 'wipes containers/images' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, why: 'publishes a package publicly' },
  { re: /\bgh\s+repo\s+delete\b|\bgh\s+release\s+delete\b/i, why: 'deletes GitHub resources' },
  { re: /\baws\s+s3\s+rm\b.*--recursive|\baws\s+s3\s+rb\b/i, why: 'deletes S3 data' },
  { re: /\bhistory\s+-c\b|\bshred\b/i, why: 'erases data irrecoverably' },
  { re: /\bmv\s+[^;&|]*\s+\/dev\/null\b/i, why: 'moves files into /dev/null' },
  { re: /\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd|network|NetworkManager)\b/i, why: 'can cut off remote access' },
  { re: /\bpasswd\b|\busermod\b|\buserdel\b|\bvisudo\b/i, why: 'changes system accounts or sudoers' },
];

export function detectDangerous(command: string): string | undefined {
  const c = command.replace(/\\\n/g, ' ');
  for (const r of RULES) if (r.re.test(c)) return r.why;
  return undefined;
}

/** Programs that only read state, whatever their arguments (unsafe flags are checked below). */
const SAFE_PROGRAMS = new Set([
  'ls', 'll', 'la', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo', 'printf', 'which', 'whereis',
  'type', 'whoami', 'id', 'date', 'uname', 'hostname', 'uptime', 'tree', 'file', 'stat', 'du', 'df', 'free', 'sort',
  'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'printenv', 'nproc', 'lscpu', 'jq', 'yq',
  'true', 'false', 'test', '[', 'sha256sum', 'sha1sum', 'md5sum', 'shasum', 'b2sum', 'column', 'nl', 'fd', 'fdfind', 'bat', 'ps', 'lsof', 'tldr',
  'seq', 'expr', 'paste', 'fold', 'fmt', 'rev', 'tac', 'od', 'hexdump', 'xxd', 'strings', 'comm', 'join', 'look', 'groups', 'locale', 'getconf', 'sleep', 'cal',
]);

/** Flags that make an otherwise read-only program write files or run commands. */
const UNSAFE_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  tree: /^(-o)$/,
  rg: /^(--pre|--pre-glob)/,
  fd: /^(-x|-X|--exec|--exec-batch)/,
  fdfind: /^(-x|-X|--exec|--exec-batch)/,
  file: /^(-C|--compile)$/,
  date: /^(-s|--set)/,
  hostname: /^[^-]/, // `hostname NAME` sets it
  xxd: /^(-r|--revert)$/, // xxd -r FILE OUT writes
  bat: /^(--pager)/,
  yq: /^(-i|--inplace)/,
  jq: /^(--rawfile|--slurpfile)$/, // reads only, but keep jq pure
};

/** Programs whose read-only use depends on the subcommand and arguments. */
function safeWithArgs(prog: string, args: string[]): boolean {
  const a0 = args[0] ?? '';
  const has = (re: RegExp) => args.some((a) => re.test(a));
  switch (prog) {
    case 'git': {
      // global options before the subcommand
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        if (/^(-c|-C|--git-dir|--work-tree)$/.test(args[i]!)) return false; // -c can set core.pager/alias to run anything
        i++;
      }
      const sub = args[i] ?? '';
      const rest = args.slice(i + 1);
      if (rest.some((a) => /^--output(=|$)|^--ext-diff$|^--exec/.test(a))) return false;
      if (['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'cat-file', 'grep', 'merge-base', 'rev-list', 'whatchanged', 'name-rev', 'count-objects', 'for-each-ref', 'show-ref', 'check-ignore', 'version', 'help'].includes(sub)) return true;
      if (sub === 'branch') return rest.every((a) => /^(-a|-r|--all|--remotes|--list|-l|-v+|--verbose|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/.test(a) || !a.startsWith('-')) && (rest.length === 0 || rest.some((a) => /^(--list|-l|--show-current|-a|-r|--all|--remotes|-v+|--contains|--merged|--no-merged)$/.test(a)));
      if (sub === 'remote') return rest.length === 0 || (rest.length <= 2 && ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]!));
      if (sub === 'tag') return rest.length === 0 || rest.every((a) => /^(-l|--list|-n\d*|--contains|--sort=.*)$/.test(a) || !a.startsWith('-')) && rest.some((a) => /^(-l|--list)$/.test(a));
      if (sub === 'config') return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
      if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
      if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
      if (sub === 'worktree') return rest[0] === 'list';
      return false;
    }
    case 'find':
      return !has(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/);
    case 'sed': {
      // only `sed -n 'Np'`-style printing; no in-place edits, no w/e commands, no script files
      if (has(/^(-i|--in-place|-f|--file|-s)/) || !has(/^-[a-zA-Z]*n|^--quiet|^--silent/)) return false;
      const scripts = args.filter((a, i) => !a.startsWith('-') || args[i - 1] === '-e');
      return scripts.every((sc) => !/(^|[;}\s])[0-9,$/!]*\s*[we]\b|\/w\s|s\/.*\/[gpI0-9]*[we]/.test(sc));
    }
    case 'awk':
    case 'gawk':
    case 'mawk':
      return !has(/system\s*\(|\|\s*"|>\s*"|getline|-f$|--file|-i/);
    case 'env':
    case 'printenv':
      return args.length === 0;
    case 'npm':
      return /^(ls|list|view|info|outdated|-v|--version|help|explain|why|query|ping|config)$/.test(a0) && (a0 !== 'config' || args[1] === 'get' || args[1] === 'list');
    case 'pnpm':
    case 'yarn':
      return /^(ls|list|outdated|info|why|-v|--version)$/.test(a0);
    case 'node':
    case 'deno':
    case 'bun':
    case 'python':
    case 'python3':
    case 'ruby':
    case 'perl':
    case 'java':
    case 'rustc':
    case 'gcc':
    case 'clang':
      return args.length === 1 && /^(-v|-V|--version|-version)$/.test(a0);
    case 'pip':
    case 'pip3':
      return /^(list|show|freeze|check|-V|--version)$/.test(a0);
    case 'cargo':
      return /^(--version|-V|tree|metadata|search|version)$/.test(a0);
    case 'go':
      return /^(version|env|list|doc)$/.test(a0) && !(a0 === 'env' && has(/^-w$|^-u$/));
    case 'docker':
    case 'podman':
      return /^(ps|images|version|info|logs|inspect)$/.test(a0) || (a0 === 'stats' && has(/^--no-stream$/));
    case 'kubectl':
      return /^(get|describe|logs|version|explain|api-resources|top)$/.test(a0) || (a0 === 'config' && /^(view|current-context|get-contexts)$/.test(args[1] ?? ''));
    case 'gh':
      return /^(pr|issue|run|repo|release|workflow)$/.test(a0) && /^(view|list|status|checks|diff)$/.test(args[1] ?? '') && !has(/^--web$|^-w$/);
    case 'cd':
      return true;
    default:
      return false;
  }
}

/** True when a single (unwrapped) command only reads state. */
export function isReadOnlyWords(words: string[]): boolean {
  const prog = (words[0] ?? '').replace(/^.*\//, '');
  const args = words.slice(1);
  if (SAFE_PROGRAMS.has(prog)) {
    const bad = UNSAFE_FLAGS[prog];
    return !bad || !args.some((a) => bad.test(a));
  }
  return safeWithArgs(prog, args);
}

/**
 * True when every command in the line only reads state. The line is parsed like a shell would
 * (quotes, `&&`/`||`/`;`/`|`, wrappers such as `env`, `xargs`, `sh -c`), and anything that cannot
 * be judged statically — command substitution, file redirections, subshells, sudo — is not
 * read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return false;
  const { commands, privileged, opaque, parsed } = commandsOf(command);
  if (opaque || privileged || !commands.length) return false;
  if (!parsed.redirects.every(harmlessRedirect)) return false;
  return commands.every(isReadOnlyWords);
}
