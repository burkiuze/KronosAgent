// Generates examples/evals/coding.yaml and coding.solutions.yaml: node scripts/gen-coding-bench.mjs (from the repo root).
// Edit the cases here; benchmark.test.ts checks every case fails as given and passes with its solution.
import { writeFileSync } from 'node:fs';
import YAML from 'yaml';

const pkg = (name) => JSON.stringify({ name, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
const nodeCheck = (code) => `node --input-type=module -e ${JSON.stringify(code)}`;
const pyCheck = (code) => `python3 - <<'PY'\n${code}\nPY`;

const cases = [];
const solutions = {};
const add = (c, solution) => {
  // hidden checks get a readable name in reports
  c.checks = c.checks.map((ch) => (ch.command && /^(node --input-type|python3 - <<)/.test(ch.command) ? { label: 'hidden tests', ...ch } : ch));
  cases.push(c);
  solutions[c.name] = solution;
};

// 1 ------------------------------------------------------------------------------------------
add(
  {
    name: 'pagination off-by-one',
    prompt: 'Page 2 of the product list shows the wrong products (it repeats the last item of page 1). Fix it.',
    files: {
      'package.json': pkg('shop'),
      'src/paginate.js': `/** Returns the items of a 1-based page. */\nexport function paginate(items, page, perPage = 10) {\n  const start = (page - 1) * perPage - 1;\n  return items.slice(Math.max(0, start), start + perPage);\n}\n`,
      'src/products.js': `import { paginate } from './paginate.js';\n\nexport const products = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: \`Product \${i + 1}\` }));\n\nexport function productPage(page) {\n  return paginate(products, page).map((p) => p.id);\n}\n`,
      'test/paginate.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { productPage } from '../src/products.js';\n\ntest('first page', () => assert.deepEqual(productPage(1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));\n`,
    },
    checks: [
      { command: 'npm test' },
      { command: nodeCheck(`import assert from 'node:assert'; import { paginate } from './src/paginate.js'; const xs = Array.from({length: 25}, (_, i) => i + 1); assert.deepEqual(paginate(xs, 1), [1,2,3,4,5,6,7,8,9,10]); assert.deepEqual(paginate(xs, 2), [11,12,13,14,15,16,17,18,19,20]); assert.deepEqual(paginate(xs, 3), [21,22,23,24,25]); assert.deepEqual(paginate(xs, 4), []); assert.deepEqual(paginate(xs, 2, 5), [6,7,8,9,10]);`) },
    ],
  },
  { 'src/paginate.js': `/** Returns the items of a 1-based page. */\nexport function paginate(items, page, perPage = 10) {\n  const start = (page - 1) * perPage;\n  return items.slice(start, start + perPage);\n}\n` },
);

// 2 ------------------------------------------------------------------------------------------
add(
  {
    name: 'cli json flag',
    prompt: 'Add a --json flag to the CLI: `node src/cli.js --json sales.csv` should print the totals as a JSON object ({"region": total, ...}) instead of the text table. Keep the text output as it is.',
    files: {
      'package.json': pkg('sales'),
      'sales.csv': 'region,amount\nnorth,10\nsouth,5\nnorth,2.5\neast,7\n',
      'src/totals.js': `export function totals(csv) {\n  const [, ...rows] = csv.trim().split('\\n');\n  const out = {};\n  for (const row of rows) {\n    const [region, amount] = row.split(',');\n    out[region] = (out[region] ?? 0) + Number(amount);\n  }\n  return out;\n}\n`,
      'src/cli.js': `import { readFileSync } from 'node:fs';\nimport { totals } from './totals.js';\n\nconst file = process.argv[2];\nif (!file) {\n  console.error('usage: node src/cli.js <file.csv>');\n  process.exit(1);\n}\nconst t = totals(readFileSync(file, 'utf8'));\nfor (const [region, total] of Object.entries(t)) console.log(\`\${region.padEnd(8)} \${total}\`);\n`,
    },
    checks: [
      { command: `node src/cli.js --json sales.csv | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.north!==12.5||j.south!==5||j.east!==7)process.exit(1)})"` },
      { command: `node src/cli.js sales.csv | grep -E '^north +12.5$'` },
    ],
  },
  {
    'src/cli.js': `import { readFileSync } from 'node:fs';\nimport { totals } from './totals.js';\n\nconst args = process.argv.slice(2);\nconst json = args.includes('--json');\nconst file = args.find((a) => !a.startsWith('--'));\nif (!file) {\n  console.error('usage: node src/cli.js [--json] <file.csv>');\n  process.exit(1);\n}\nconst t = totals(readFileSync(file, 'utf8'));\nif (json) console.log(JSON.stringify(t));\nelse for (const [region, total] of Object.entries(t)) console.log(\`\${region.padEnd(8)} \${total}\`);\n`,
  },
);

// 3 ------------------------------------------------------------------------------------------
add(
  {
    name: 'rename across files',
    prompt: 'Rename the function getUsr to getUser everywhere in this project (definition, imports and call sites). Behaviour must not change.',
    files: {
      'package.json': pkg('users'),
      'src/users.js': `const USERS = { 1: 'ada', 2: 'linus' };\n\nexport function getUsr(id) {\n  return USERS[id] ?? null;\n}\n`,
      'src/greet.js': `import { getUsr } from './users.js';\n\nexport const greet = (id) => \`hello \${getUsr(id) ?? 'stranger'}\`;\n`,
      'src/admin.js': `import { getUsr } from './users.js';\n\nexport function isAdmin(id) {\n  return getUsr(id) === 'ada';\n}\n`,
      'test/users.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { greet } from '../src/greet.js';\nimport { isAdmin } from '../src/admin.js';\n\ntest('greet', () => assert.equal(greet(2), 'hello linus'));\ntest('admin', () => assert.equal(isAdmin(1), true));\n`,
    },
    checks: [{ command: '! grep -rn getUsr src test' }, { command: 'npm test' }, { command: nodeCheck(`import assert from 'node:assert'; import { getUser } from './src/users.js'; assert.equal(getUser(1), 'ada'); assert.equal(getUser(3), null);`) }],
  },
  {
    'src/users.js': `const USERS = { 1: 'ada', 2: 'linus' };\n\nexport function getUser(id) {\n  return USERS[id] ?? null;\n}\n`,
    'src/greet.js': `import { getUser } from './users.js';\n\nexport const greet = (id) => \`hello \${getUser(id) ?? 'stranger'}\`;\n`,
    'src/admin.js': `import { getUser } from './users.js';\n\nexport function isAdmin(id) {\n  return getUser(id) === 'ada';\n}\n`,
  },
);

// 4 ------------------------------------------------------------------------------------------
add(
  {
    name: 'crash from a log',
    prompt: 'The service crashed in production, see logs/crash.log. Find the cause and fix it so it cannot happen again (configs without a retry section are valid).',
    files: {
      'package.json': pkg('svc'),
      'logs/crash.log': `2026-10-20T09:14:02Z INFO starting worker pool\n2026-10-20T09:14:02Z ERROR unhandled exception\nTypeError: Cannot read properties of undefined (reading 'attempts')\n    at retryPolicy (file:///srv/app/src/config.js:4:25)\n    at startWorker (file:///srv/app/src/worker.js:5:17)\n`,
      'src/config.js': `const DEFAULTS = { attempts: 3, delayMs: 200 };\n\nexport function retryPolicy(config) {\n  const attempts = config.retry.attempts ?? DEFAULTS.attempts;\n  const delayMs = config.retry.delayMs ?? DEFAULTS.delayMs;\n  return { attempts, delayMs };\n}\n`,
      'src/worker.js': `import { retryPolicy } from './config.js';\n\nexport function startWorker(config) {\n  const name = config.name ?? 'worker';\n  const policy = retryPolicy(config);\n  return \`\${name}: \${policy.attempts} attempts, \${policy.delayMs}ms\`;\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { startWorker } from './src/worker.js'; assert.equal(startWorker({ name: 'w' }), 'w: 3 attempts, 200ms'); assert.equal(startWorker({ retry: { attempts: 5 } }), 'worker: 5 attempts, 200ms'); assert.equal(startWorker({ retry: { attempts: 0, delayMs: 0 } }), 'worker: 0 attempts, 0ms');`) },
    ],
  },
  { 'src/config.js': `const DEFAULTS = { attempts: 3, delayMs: 200 };\n\nexport function retryPolicy(config) {\n  const retry = config.retry ?? {};\n  return { attempts: retry.attempts ?? DEFAULTS.attempts, delayMs: retry.delayMs ?? DEFAULTS.delayMs };\n}\n` },
);

// 5 ------------------------------------------------------------------------------------------
add(
  {
    name: 'implement to spec',
    prompt: 'Implement compare() in src/semver.js following the spec in SPEC.md.',
    files: {
      'package.json': pkg('semver'),
      'SPEC.md': `# compare(a, b)\n\nCompares two versions of the form MAJOR.MINOR.PATCH with an optional pre-release (\`1.2.3-beta.1\`).\nReturns -1 if a < b, 0 if equal, 1 if a > b.\n\n- Major, minor and patch compare numerically (\`1.10.0\` > \`1.9.0\`).\n- A version with a pre-release is lower than the same version without one (\`1.0.0-rc.1\` < \`1.0.0\`).\n- Pre-releases compare part by part, split on dots: numeric parts numerically, others as strings,\n  numeric parts are lower than non-numeric ones, and a shorter list is lower when all earlier parts are equal\n  (\`alpha\` < \`alpha.1\` < \`alpha.beta\` < \`beta\` < \`beta.2\` < \`beta.11\` < \`rc.1\`).\n- A leading \`v\` is ignored (\`v1.2.3\` equals \`1.2.3\`).\n`,
      'src/semver.js': `export function compare(a, b) {\n  throw new Error('not implemented');\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { compare } from './src/semver.js'; const order = ['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0','1.9.0','1.10.0','2.0.0']; for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(compare(order[i], order[j]), Math.sign(i - j), order[i] + ' vs ' + order[j]); assert.equal(compare('v1.2.3', '1.2.3'), 0);`) },
    ],
  },
  {
    'src/semver.js': `function parse(v) {\n  const [core, pre] = v.replace(/^v/, '').split(/-(.*)/s);\n  return { nums: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };\n}\n\nfunction comparePart(x, y) {\n  const nx = /^\\d+$/.test(x);\n  const ny = /^\\d+$/.test(y);\n  if (nx && ny) return Math.sign(Number(x) - Number(y));\n  if (nx) return -1;\n  if (ny) return 1;\n  return x < y ? -1 : x > y ? 1 : 0;\n}\n\nexport function compare(a, b) {\n  const A = parse(a);\n  const B = parse(b);\n  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return Math.sign(A.nums[i] - B.nums[i]);\n  if (!A.pre.length || !B.pre.length) return A.pre.length ? -1 : B.pre.length ? 1 : 0;\n  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {\n    if (A.pre[i] === undefined) return -1;\n    if (B.pre[i] === undefined) return 1;\n    const c = comparePart(A.pre[i], B.pre[i]);\n    if (c) return c;\n  }\n  return 0;\n}\n`,
  },
);

// 6 ------------------------------------------------------------------------------------------
add(
  {
    name: 'python shared state bug',
    prompt: 'Carts created separately end up sharing items in this Python project. Find and fix the bug.',
    files: {
      'shop/__init__.py': '',
      'tests/__init__.py': '',
      'shop/cart.py': `class Cart:\n    def __init__(self, owner, items=[]):\n        self.owner = owner\n        self.items = items\n\n    def add(self, item, qty=1):\n        self.items.append((item, qty))\n        return self\n\n    def count(self):\n        return sum(q for _, q in self.items)\n`,
      'tests/test_cart.py': `import unittest\nfrom shop.cart import Cart\n\n\nclass CartTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(Cart('a').add('apple', 2).count(), 2)\n\n\nif __name__ == '__main__':\n    unittest.main()\n`,
    },
    checks: [
      { command: 'python3 -m unittest discover -s tests -t .' },
      { command: pyCheck(`from shop.cart import Cart\na = Cart('a').add('x')\nb = Cart('b')\nassert b.count() == 0, b.items\nc = Cart('c', [('y', 2)])\nassert c.count() == 2\nassert Cart('d').count() == 0`) },
    ],
  },
  { 'shop/cart.py': `class Cart:\n    def __init__(self, owner, items=None):\n        self.owner = owner\n        self.items = list(items) if items is not None else []\n\n    def add(self, item, qty=1):\n        self.items.append((item, qty))\n        return self\n\n    def count(self):\n        return sum(q for _, q in self.items)\n` },
);

// 7 ------------------------------------------------------------------------------------------
add(
  {
    name: 'python feature with tests',
    prompt: 'Add a to_csv() method to Report in report.py that returns the rows as CSV text with a header line (columns in the order of `columns`). Values containing commas, quotes or newlines must be quoted correctly. Add a test for it.',
    files: {
      'report.py': `class Report:\n    def __init__(self, columns, rows):\n        self.columns = columns\n        self.rows = rows  # list of dicts\n\n    def total(self, column):\n        return sum(r[column] for r in self.rows)\n`,
      'test_report.py': `import unittest\nfrom report import Report\n\n\nclass ReportTest(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(Report(['n'], [{'n': 1}, {'n': 2}]).total('n'), 3)\n\n\nif __name__ == '__main__':\n    unittest.main()\n`,
    },
    checks: [
      { command: pyCheck(`import csv, io\nfrom report import Report\nr = Report(['name', 'note'], [{'note': 'a, b', 'name': 'x'}, {'name': 'y', 'note': 'say "hi"'}, {'name': 'z', 'note': 'two\\nlines'}])\nout = r.to_csv()\nrows = list(csv.reader(io.StringIO(out)))\nassert rows[0] == ['name', 'note'], rows\nassert rows[1] == ['x', 'a, b'], rows\nassert rows[2] == ['y', 'say "hi"'], rows\nassert rows[3] == ['z', 'two\\nlines'], rows`) },
      { command: `python3 -m unittest test_report -v 2>&1 | grep -qiE 'csv.* \\.\\.\\. ok'` },
    ],
  },
  {
    'report.py': `import csv\nimport io\n\n\nclass Report:\n    def __init__(self, columns, rows):\n        self.columns = columns\n        self.rows = rows  # list of dicts\n\n    def total(self, column):\n        return sum(r[column] for r in self.rows)\n\n    def to_csv(self):\n        buf = io.StringIO()\n        w = csv.writer(buf, lineterminator='\\n')\n        w.writerow(self.columns)\n        for r in self.rows:\n            w.writerow([r.get(c, '') for c in self.columns])\n        return buf.getvalue()\n`,
    'test_report.py': `import unittest\nfrom report import Report\n\n\nclass ReportTest(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(Report(['n'], [{'n': 1}, {'n': 2}]).total('n'), 3)\n\n    def test_to_csv(self):\n        self.assertEqual(Report(['a'], [{'a': 'x,y'}]).to_csv(), 'a\\n"x,y"\\n')\n\n\nif __name__ == '__main__':\n    unittest.main()\n`,
  },
);

// 8 ------------------------------------------------------------------------------------------
add(
  {
    name: 'async forEach bug',
    prompt: 'syncAll() in src/sync.js returns before the records are saved, so the count it reports is often 0. Fix it; saves may run in parallel.',
    files: {
      'package.json': pkg('sync'),
      'src/store.js': `export const saved = [];\n\nexport async function save(record) {\n  await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));\n  saved.push(record.id);\n}\n`,
      'src/sync.js': `import { save, saved } from './store.js';\n\nexport async function syncAll(records) {\n  records.forEach(async (r) => {\n    await save(r);\n  });\n  return saved.length;\n}\n`,
    },
    checks: [{ command: nodeCheck(`import assert from 'node:assert'; import { syncAll } from './src/sync.js'; const n = await syncAll(Array.from({ length: 20 }, (_, i) => ({ id: i }))); assert.equal(n, 20);`) }],
  },
  { 'src/sync.js': `import { save, saved } from './store.js';\n\nexport async function syncAll(records) {\n  await Promise.all(records.map((r) => save(r)));\n  return saved.length;\n}\n` },
);

// 9 ------------------------------------------------------------------------------------------
add(
  {
    name: 'parse durations',
    prompt: 'parseDuration("1h30m") works but parseDuration("45s"), parseDuration("2h") and parseDuration("1d 2h") do not. Make it handle any combination of d, h, m and s (optionally separated by spaces) and throw on invalid input.',
    files: {
      'package.json': pkg('dur'),
      'src/duration.js': `/** "1h30m" → seconds */\nexport function parseDuration(text) {\n  const m = /^(\\d+)h(\\d+)m$/.exec(text);\n  return Number(m[1]) * 3600 + Number(m[2]) * 60;\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { parseDuration as p } from './src/duration.js'; assert.equal(p('1h30m'), 5400); assert.equal(p('45s'), 45); assert.equal(p('2h'), 7200); assert.equal(p('1d 2h'), 93600); assert.equal(p('1d2h3m4s'), 93784); for (const bad of ['', 'abc', '5x', '1h 2', 'h']) assert.throws(() => p(bad), bad);`) },
    ],
  },
  { 'src/duration.js': `const UNITS = { d: 86400, h: 3600, m: 60, s: 1 };\n\n/** "1h30m", "45s", "1d 2h" → seconds */\nexport function parseDuration(text) {\n  const s = String(text).trim();\n  if (!/^(\\d+[dhms]\\s*)+$/.test(s)) throw new Error(\`invalid duration: \${text}\`);\n  let total = 0;\n  for (const [, n, u] of s.matchAll(/(\\d+)([dhms])/g)) total += Number(n) * UNITS[u];\n  return total;\n}\n` },
);

// 10 -----------------------------------------------------------------------------------------
add(
  {
    name: 'make it fast',
    prompt: 'uniqueEmails() in src/dedupe.js is far too slow on our real data (200k addresses). Make it fast without changing its results (first occurrence wins, comparison ignores case and surrounding spaces).',
    files: {
      'package.json': pkg('dedupe'),
      'src/dedupe.js': `export function uniqueEmails(list) {\n  const out = [];\n  for (const raw of list) {\n    const email = raw.trim().toLowerCase();\n    if (!out.some((e) => e === email)) out.push(email);\n  }\n  return out;\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { uniqueEmails } from './src/dedupe.js'; assert.deepEqual(uniqueEmails([' A@x.io', 'a@x.io', 'b@x.io ', 'B@X.IO']), ['a@x.io', 'b@x.io']); const big = Array.from({ length: 60000 }, (_, i) => 'user' + (i % 50000) + '@x.io'); const t = performance.now(); const r = uniqueEmails(big); const ms = performance.now() - t; assert.equal(r.length, 50000); assert.ok(ms < 1000, 'took ' + ms + 'ms');`) },
    ],
  },
  { 'src/dedupe.js': `export function uniqueEmails(list) {\n  const seen = new Set();\n  for (const raw of list) seen.add(raw.trim().toLowerCase());\n  return [...seen];\n}\n` },
);

// 11 -----------------------------------------------------------------------------------------
add(
  {
    name: 'path traversal',
    prompt: 'Security review flagged src/static.js: resolveSafe() lets a request escape the public directory. Fix it so only files inside the root can be served (return null otherwise).',
    files: {
      'package.json': pkg('static'),
      'src/static.js': `import { join } from 'node:path';\n\n/** Maps a URL path to a file inside root, or null when it is not allowed. */\nexport function resolveSafe(root, urlPath) {\n  const clean = decodeURIComponent(urlPath).replace('../', '');\n  return join(root, clean);\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { join } from 'node:path'; import { resolveSafe as r } from './src/static.js'; const root = '/srv/public'; assert.equal(r(root, '/index.html'), join(root, 'index.html')); assert.equal(r(root, '/css/a.css'), join(root, 'css/a.css')); assert.equal(r(root, '/a/../b.txt'), join(root, 'b.txt')); for (const bad of ['/../etc/passwd', '/../../etc/passwd', '/..%2F..%2Fetc/passwd', '/a/../../../etc/passwd', '%2e%2e/%2e%2e/secret', '/../public2/x', '/....//....//etc/passwd']) { const out = r(root, bad); assert.ok(out === null || out.startsWith(root + '/'), bad + ' -> ' + out); }`) },
    ],
  },
  { 'src/static.js': `import { resolve, sep } from 'node:path';\n\n/** Maps a URL path to a file inside root, or null when it is not allowed. */\nexport function resolveSafe(root, urlPath) {\n  let decoded;\n  try {\n    decoded = decodeURIComponent(urlPath);\n  } catch {\n    return null;\n  }\n  const base = resolve(root);\n  const full = resolve(base, '.' + sep + decoded);\n  return full.startsWith(base + sep) ? full : null;\n}\n` },
);

// 12 -----------------------------------------------------------------------------------------
add(
  {
    name: 'config migration',
    prompt: 'Implement migrate() in src/migrate.js as described in docs/MIGRATION.md.',
    files: {
      'package.json': pkg('cfg'),
      'docs/MIGRATION.md': `# Config v1 → v2\n\nmigrate(config) takes a v1 or v2 config object and returns a v2 config (a v2 config is returned unchanged).\n\nv1 looks like: \`{ "version": 1, "host": "db.local", "port": "5432", "user": "app", "ssl": "yes", "pool": 10 }\`\n\nv2 looks like: \`{ "version": 2, "database": { "url": "postgres://app@db.local:5432", "ssl": true }, "pool": { "max": 10 } }\`\n\nRules:\n- \`port\` becomes a number in the URL; when missing, use 5432.\n- \`ssl\` is true for "yes", "true", "1" or true; false otherwise.\n- \`pool\` defaults to 5.\n- Unknown v1 keys are kept under \`legacy\` (omit \`legacy\` when there are none).\n- Any other version throws an Error.\n`,
      'src/migrate.js': `export function migrate(config) {\n  throw new Error('not implemented');\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { migrate } from './src/migrate.js'; assert.deepEqual(migrate({ version: 1, host: 'db.local', port: '5432', user: 'app', ssl: 'yes', pool: 10 }), { version: 2, database: { url: 'postgres://app@db.local:5432', ssl: true }, pool: { max: 10 } }); assert.deepEqual(migrate({ version: 1, host: 'h', user: 'u', ssl: 'no', region: 'eu' }), { version: 2, database: { url: 'postgres://u@h:5432', ssl: false }, pool: { max: 5 }, legacy: { region: 'eu' } }); const v2 = { version: 2, database: { url: 'postgres://x@y:1', ssl: false }, pool: { max: 1 } }; assert.deepEqual(migrate(v2), v2); assert.throws(() => migrate({ version: 3 }));`) },
    ],
  },
  { 'src/migrate.js': `const KNOWN = new Set(['version', 'host', 'port', 'user', 'ssl', 'pool']);\n\nexport function migrate(config) {\n  if (config.version === 2) return config;\n  if (config.version !== 1) throw new Error(\`unsupported config version: \${config.version}\`);\n  const port = config.port === undefined ? 5432 : Number(config.port);\n  const ssl = ['yes', 'true', '1', true].includes(config.ssl);\n  const out = { version: 2, database: { url: \`postgres://\${config.user}@\${config.host}:\${port}\`, ssl }, pool: { max: config.pool ?? 5 } };\n  const legacy = Object.fromEntries(Object.entries(config).filter(([k]) => !KNOWN.has(k)));\n  if (Object.keys(legacy).length) out.legacy = legacy;\n  return out;\n}\n` },
);

// 13 -----------------------------------------------------------------------------------------
add(
  {
    name: 'write the tests',
    prompt: 'src/slugify.js has no tests. Add a test file with node:test covering its behaviour, including edge cases (accents, punctuation, repeated separators, leading/trailing separators, empty input). Do not change slugify itself.',
    files: {
      'package.json': pkg('slug'),
      'src/slugify.js': `/** "Héllo, World!" → "hello-world" */\nexport function slugify(text) {\n  return String(text)\n    .normalize('NFKD')\n    .replace(/[\\u0300-\\u036f]/g, '')\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, '-')\n    .replace(/^-+|-+$/g, '');\n}\n`,
    },
    checks: [
      { command: `node --test --test-reporter=tap 2>&1 | grep -qE '^# pass ([4-9]|[1-9][0-9])$' && node --test --test-reporter=tap 2>&1 | grep -qE '^# fail 0$'` },
      { command: `grep -q "normalize('NFKD')" src/slugify.js` },
      // the tests must catch a broken implementation
      { command: `cp src/slugify.js .slugify.orig && printf 'export function slugify(t) { return String(t).toLowerCase().replace(/ /g, "-"); }\\n' > src/slugify.js; if node --test >/dev/null 2>&1; then mv .slugify.orig src/slugify.js; exit 1; fi; mv .slugify.orig src/slugify.js` },
    ],
  },
  {
    'test/slugify.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { slugify } from '../src/slugify.js';\n\ntest('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));\ntest('accents', () => assert.equal(slugify('Héllo Çağ'), 'hello-cag'));\ntest('punctuation and repeats', () => assert.equal(slugify('a,  b!!c'), 'a-b-c'));\ntest('trim separators', () => assert.equal(slugify('  --x--  '), 'x'));\ntest('empty', () => assert.equal(slugify(''), ''));\n`,
  },
);

// 14 -----------------------------------------------------------------------------------------
add(
  {
    name: 'event emitter once',
    prompt: 'Handlers registered with once() in src/emitter.js fire more than once. Fix it.',
    files: {
      'package.json': pkg('emitter'),
      'src/emitter.js': `export class Emitter {\n  #handlers = new Map();\n\n  on(event, fn) {\n    const list = this.#handlers.get(event) ?? [];\n    list.push(fn);\n    this.#handlers.set(event, list);\n    return () => this.off(event, fn);\n  }\n\n  off(event, fn) {\n    const list = this.#handlers.get(event) ?? [];\n    this.#handlers.set(event, list.filter((f) => f !== fn));\n  }\n\n  once(event, fn) {\n    const wrapper = (...args) => {\n      this.off(event, fn);\n      fn(...args);\n    };\n    return this.on(event, wrapper);\n  }\n\n  emit(event, ...args) {\n    for (const fn of this.#handlers.get(event) ?? []) fn(...args);\n  }\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { Emitter } from './src/emitter.js'; const e = new Emitter(); let a = 0, b = 0; e.once('x', () => a++); e.on('x', () => b++); e.emit('x'); e.emit('x'); assert.equal(a, 1); assert.equal(b, 2); let c = 0; const off = e.once('y', () => c++); off(); e.emit('y'); assert.equal(c, 0); let d = 0; e.once('z', () => { d++; e.emit('z'); }); e.emit('z'); assert.equal(d, 1);`) },
    ],
  },
  { 'src/emitter.js': `export class Emitter {\n  #handlers = new Map();\n\n  on(event, fn) {\n    const list = this.#handlers.get(event) ?? [];\n    list.push(fn);\n    this.#handlers.set(event, list);\n    return () => this.off(event, fn);\n  }\n\n  off(event, fn) {\n    const list = this.#handlers.get(event) ?? [];\n    this.#handlers.set(event, list.filter((f) => f !== fn));\n  }\n\n  once(event, fn) {\n    const wrapper = (...args) => {\n      this.off(event, wrapper);\n      fn(...args);\n    };\n    return this.on(event, wrapper);\n  }\n\n  emit(event, ...args) {\n    for (const fn of [...(this.#handlers.get(event) ?? [])]) fn(...args);\n  }\n}\n` },
);

// 15 -----------------------------------------------------------------------------------------
add(
  {
    name: 'feature across layers',
    prompt: 'Todos need a priority: "high", "normal" (default) or "low". Add it to the model, keep it when saving and loading, and make list() return high first, then normal, then low (oldest first within a priority). Old saved files without priorities must still load.',
    files: {
      'package.json': pkg('todos'),
      'src/model.js': `let next = 1;\n\nexport function createTodo(title) {\n  if (!title?.trim()) throw new Error('title required');\n  return { id: next++, title: title.trim(), done: false, createdAt: Date.now() + next };\n}\n`,
      'src/store.js': `import { readFileSync, writeFileSync, existsSync } from 'node:fs';\n\nexport function load(file) {\n  if (!existsSync(file)) return [];\n  return JSON.parse(readFileSync(file, 'utf8')).map((t) => ({ id: t.id, title: t.title, done: t.done, createdAt: t.createdAt }));\n}\n\nexport function save(file, todos) {\n  writeFileSync(file, JSON.stringify(todos.map((t) => ({ id: t.id, title: t.title, done: t.done, createdAt: t.createdAt }))));\n}\n`,
      'src/todos.js': `import { createTodo } from './model.js';\n\nexport class Todos {\n  constructor(items = []) {\n    this.items = items;\n  }\n\n  add(title) {\n    const t = createTodo(title);\n    this.items.push(t);\n    return t;\n  }\n\n  list() {\n    return [...this.items].sort((a, b) => a.createdAt - b.createdAt);\n  }\n}\n`,
    },
    checks: [
      { command: nodeCheck(`import assert from 'node:assert'; import { writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { Todos } from './src/todos.js'; import { load, save } from './src/store.js'; const t = new Todos(); t.add('a'); t.add('b', 'low'); t.add('c', 'high'); t.add('d'); t.add('e', 'high'); assert.deepEqual(t.list().map((x) => x.title), ['c', 'e', 'a', 'd', 'b']); assert.equal(t.items[0].priority, 'normal'); assert.throws(() => t.add('x', 'urgent')); const f = join(tmpdir(), 'kronos-todos-' + process.pid + '.json'); save(f, t.items); const back = new Todos(load(f)); assert.deepEqual(back.list().map((x) => [x.title, x.priority]), [['c','high'],['e','high'],['a','normal'],['d','normal'],['b','low']]); writeFileSync(f, JSON.stringify([{ id: 9, title: 'old', done: false, createdAt: 1 }])); assert.equal(load(f)[0].priority, 'normal');`) },
    ],
  },
  {
    'src/model.js': `let next = 1;\n\nexport const PRIORITIES = ['high', 'normal', 'low'];\n\nexport function createTodo(title, priority = 'normal') {\n  if (!title?.trim()) throw new Error('title required');\n  if (!PRIORITIES.includes(priority)) throw new Error(\`invalid priority: \${priority}\`);\n  return { id: next++, title: title.trim(), done: false, priority, createdAt: Date.now() + next };\n}\n`,
    'src/store.js': `import { readFileSync, writeFileSync, existsSync } from 'node:fs';\n\nexport function load(file) {\n  if (!existsSync(file)) return [];\n  return JSON.parse(readFileSync(file, 'utf8')).map((t) => ({ id: t.id, title: t.title, done: t.done, priority: t.priority ?? 'normal', createdAt: t.createdAt }));\n}\n\nexport function save(file, todos) {\n  writeFileSync(file, JSON.stringify(todos.map((t) => ({ id: t.id, title: t.title, done: t.done, priority: t.priority, createdAt: t.createdAt }))));\n}\n`,
    'src/todos.js': `import { createTodo, PRIORITIES } from './model.js';\n\nexport class Todos {\n  constructor(items = []) {\n    this.items = items;\n  }\n\n  add(title, priority) {\n    const t = createTodo(title, priority);\n    this.items.push(t);\n    return t;\n  }\n\n  list() {\n    const rank = (t) => PRIORITIES.indexOf(t.priority ?? 'normal');\n    return [...this.items].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);\n  }\n}\n`,
  },
);

const LABELS = {
  'pagination off-by-one': ['project tests', 'hidden tests'],
  'cli json flag': ['--json prints the totals', 'text output unchanged'],
  'rename across files': ['no getUsr left', 'project tests', 'hidden tests'],
  'python shared state bug': ['project tests', 'hidden tests'],
  'python feature with tests': ['hidden tests', 'a CSV test was added and passes'],
  'write the tests': ['4+ tests, all passing', 'slugify unchanged', 'the tests catch a broken slugify'],
};
for (const c of cases) for (const [i, label] of (LABELS[c.name] ?? []).entries()) c.checks[i] = { label, ...c.checks[i], ...(c.checks[i].label ? { label } : {}) };

const header = `# Coding benchmark: ${cases.length} realistic tasks — bugs, features, refactors, debugging from a log,
# performance, security, writing tests — in JavaScript and Python (no dependencies to install).
# Every case is graded by hidden checks the agent never sees, and CI proves each one fails on the
# starting code and passes with a reference solution (coding.solutions.yaml), so a pass is real.
#
#   kronos eval examples/evals/coding.yaml --repeats 3
#   kronos eval examples/evals/coding.yaml --model ollama:qwen2.5-coder:7b --repeats 3
#   matrix: { model: [sonnet, "ollama:qwen2.5-coder:7b"], effort: [medium] }   # compare configurations
`;
const suite = { name: 'coding', repeats: 3, timeoutSec: 900, cases };
writeFileSync('examples/evals/coding.yaml', header + YAML.stringify(suite, { lineWidth: 0, blockQuote: 'literal' }));
writeFileSync(
  'examples/evals/coding.solutions.yaml',
  '# Reference solutions for coding.yaml (files written over the fixtures). Used by the suite\'s CI\n# self-test; never shown to the agent being evaluated.\n' + YAML.stringify(solutions, { lineWidth: 0, blockQuote: 'literal' }),
);
console.log(`wrote ${cases.length} cases`);
