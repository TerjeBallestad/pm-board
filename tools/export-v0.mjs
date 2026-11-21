#!/usr/bin/env node
// Dump one 0.x board to JSON, read by the 0.x store itself (DD-013), for
// `PmBoard.Api import`. The board is copied to a temp folder first, because
// the 0.x store creates missing folders when it loads, and this must never
// change the real repo.
//
//   node export-v0.mjs <folder with pm.config.json> [--slug <slug>] > board.json
import { cpSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const src = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
const configPath = join(src, 'pm.config.json');
if (!existsSync(configPath)) {
  console.error(`no pm.config.json in ${src}`);
  process.exit(2);
}
const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const dataDir = resolve(src, rawConfig.dataDir ?? '.pm/data');

// Copy only the config and the data dir, at the same relative place.
const work = mkdtempSync(join(tmpdir(), 'pm-export-'));
cpSync(configPath, join(work, 'pm.config.json'));
const rel = relative(src, dataDir);
cpSync(dataDir, join(work, rel), { recursive: true });

// The 0.x store remembers the newest timestamp it saw, for rewind detection.
// Keep that state in the temp folder too.
process.env.PM_STATE_DIR = join(work, '.state');

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@terjeballestad/pm-board-cli/package.json'));
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const { loadConfig, getConfig } = await import(join(pkgDir, 'lib', 'config.js'));
const store = await import(join(pkgDir, 'lib', 'store.js'));

loadConfig(work);
const data = store.load();
const archive = store.getArchive();
const quarantined = store.getQuarantined();

// Files next to the data that the 0.x store never reads (for example the
// *.tests.json catalogue files). Listed so the report can say what was left out.
const notRead = [];
for (const col of readdirSync(join(work, rel), { withFileTypes: true })) {
  if (!col.isDirectory()) continue;
  for (const f of readdirSync(join(work, rel, col.name))) {
    const json = ['plans', 'sprints', 'milestones'].includes(col.name);
    const read = json ? f.endsWith('.json') : f.endsWith('.md');
    if (!read || f.endsWith('.tests.json')) notRead.push(`${col.name}/${f}`);
  }
}

const config = getConfig();
const keep = ['stages', 'entityTypes', 'commands', 'knowledgeBase', 'templates', 'frontend'];

const dump = {
  format: 'pm-v0-export',
  exportedWith: version,
  source: src,
  project: {
    slug: slugArg ?? basename(src),
    name: config.name ?? basename(src),
    config: Object.fromEntries(keep.filter((k) => k in config).map((k) => [k, config[k]])),
  },
  items: data.items,
  designs: data.designs,
  plans: data.plans,
  sprints: data.sprints,
  milestones: data.milestones,
  archive: { items: archive.items, designs: archive.designs, archivedAt: archive.archivedAt },
  quarantined,
  notRead,
};

rmSync(work, { recursive: true, force: true });
process.stdout.write(JSON.stringify(dump, null, 2) + '\n');
// The 0.x events module keeps a keepalive timer running.
process.exit(0);
