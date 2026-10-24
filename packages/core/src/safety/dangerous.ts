/** Detection of destructive / irreversible shell commands. */

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

const SAFE_PROGRAMS = new Set([
  'ls', 'll', 'la', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo', 'printf', 'which', 'whereis',
  'type', 'whoami', 'id', 'date', 'uname', 'hostname', 'uptime', 'tree', 'file', 'stat', 'du', 'df', 'free', 'less', 'more', 'sort',
  'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'env', 'printenv', 'nproc', 'lscpu', 'jq', 'yq',
  'true', 'false', 'test', 'sha256sum', 'md5sum', 'shasum', 'column', 'nl', 'fd', 'bat', 'ps', 'top', 'lsof', 'man', 'tldr',
]);

const SAFE_SUBCOMMANDS: Record<string, RegExp> = {
  git: /^git\s+(status|log|diff|show|branch(\s+(-a|-r|--list|-v+))*\s*$|remote(\s+-v)?\s*$|rev-parse|ls-files|blame|describe|tag(\s+-l)?\s*$|config\s+--get|stash\s+list|shortlog|reflog\s*$)/,
  npm: /^npm\s+(ls|list|view|outdated|-v|--version|config\s+get|run\s*$|help)/,
  pnpm: /^pnpm\s+(ls|list|outdated|-v|--version)/,
  yarn: /^yarn\s+(list|info|-v|--version)/,
  node: /^node\s+(-v|--version|-p\s)/,
  python: /^python3?\s+(-V|--version)/,
  python3: /^python3?\s+(-V|--version)/,
  pip: /^pip3?\s+(list|show|freeze|-V|--version)/,
  cargo: /^cargo\s+(--version|tree|metadata)/,
  go: /^go\s+(version|env|list)/,
  docker: /^docker\s+(ps|images|version|info|logs|inspect)/,
  kubectl: /^kubectl\s+(get|describe|logs|version|config\s+(view|current-context))/,
  find: /^find\s+(?!.*(-delete|-exec|-execdir|-ok|-fprint))/,
  sed: /^sed\s+-n\s/,
  awk: /^awk\s+(?!.*(system|>))/,
  gh: /^gh\s+(pr|issue|run|repo)\s+(view|list|status|checks|diff)/,
};

/** True when every segment of the command line only reads state. */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /[`]|\$\(|>|\btee\b|<\(/.test(c)) return false;
  const segments = c.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  return segments.every((seg) => {
    const s = seg.replace(/^(sudo\s+)?(env\s+\S+=\S+\s+)*/, '').trim();
    const prog = s.split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
    if (SAFE_SUBCOMMANDS[prog]) return SAFE_SUBCOMMANDS[prog].test(s);
    return SAFE_PROGRAMS.has(prog) && !/^sudo\s/.test(seg.trim());
  });
}
