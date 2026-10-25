// Bundles the Electron main + preload with esbuild and stages the web UI and bundled skills
// next to them, so `electron .` and electron-builder both find everything under apps/desktop.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const watch = process.argv.includes('--watch');

rmSync(join(here, 'dist'), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  logLevel: 'info',
  // native/optional modules stay external; electron is provided by the runtime
  external: ['electron', 'electron-updater', 'bufferutil', 'utf-8-validate', 'playwright', 'playwright-core'],
  alias: {
    '@kronos/core': join(root, 'packages/core/src/index.ts'),
    '@kronos/gateway': join(root, 'packages/gateway/src/index.ts'),
  },
  // ESM sources use import.meta.url for path discovery; give CJS an equivalent
  define: { 'import.meta.url': '__kronos_import_meta_url' },
  banner: { js: "const __kronos_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
};

await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'dist/main.cjs') });
// sandboxed preloads may only require('electron'): no banner/define, nothing else external
await build({ ...common, define: {}, banner: {}, entryPoints: [join(here, 'src/preload.ts')], outfile: join(here, 'dist/preload.cjs'), external: ['electron'] });

// stage the web UI
const web = join(root, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) {
  console.error('apps/web/dist is missing — run `npm run build:web` first.');
  process.exit(1);
}
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(web, join(here, 'web'), { recursive: true });

// stage bundled skills
rmSync(join(here, 'skills'), { recursive: true, force: true });
if (existsSync(join(root, 'skills'))) cpSync(join(root, 'skills'), join(here, 'skills'), { recursive: true });

// app icons (generated from the procedural Kronos portrait unless real artwork exists)
mkdirSync(join(here, 'build'), { recursive: true });
if (!existsSync(join(here, 'build/icon.png'))) {
  const { kronosPortrait } = await import(join(root, 'packages/core/dist/media/png.js'));
  writeFileSync(join(here, 'build/icon.png'), kronosPortrait('Kronos, keeper of time', 1024));
  writeFileSync(join(here, 'build/tray.png'), kronosPortrait('Kronos, keeper of time', 64));
}

console.log(`desktop bundle ready${watch ? ' (watch not supported, rebuilt once)' : ''}`);
