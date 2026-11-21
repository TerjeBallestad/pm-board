// Open a 0.x board with the 0.x code itself, from a temp copy. The 0.x store
// creates missing folders and writes rewind state when it loads, and that must
// never touch the real repo.
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';

export async function openV0Board(folder) {
  const src = resolve(folder);
  const configPath = join(src, 'pm.config.json');
  if (!existsSync(configPath)) throw new Error(`no pm.config.json in ${src}`);
  const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const dataDir = resolve(src, rawConfig.dataDir ?? '.pm/data');

  const work = mkdtempSync(join(tmpdir(), 'pm-v0-'));
  cpSync(configPath, join(work, 'pm.config.json'));
  const rel = relative(src, dataDir);
  // Hidden folders (the data dir's own .git) are not board data.
  cpSync(dataDir, join(work, rel), { recursive: true, filter: (f) => !basename(f).startsWith('.') || f === dataDir });
  // A board's own prompt templates, which 0.x reads relative to pm.config.json.
  if (rawConfig.templates && existsSync(resolve(src, rawConfig.templates))) {
    cpSync(resolve(src, rawConfig.templates), join(work, rawConfig.templates), { recursive: true });
  }
  process.env.PM_STATE_DIR = join(work, '.state');

  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('@terjeballestad/pm-board-cli/package.json'));
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const config = await import(join(pkgDir, 'lib', 'config.js'));
  config.loadConfig(work);
  const store = await import(join(pkgDir, 'lib', 'store.js'));
  const { dispatch } = await import(join(pkgDir, 'lib', 'dispatch.js'));

  return {
    src,
    work,
    dataDir: join(work, rel),
    version,
    config,
    store,
    dispatch,
    close: () => rmSync(work, { recursive: true, force: true }),
  };
}
