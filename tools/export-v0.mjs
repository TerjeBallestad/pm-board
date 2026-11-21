#!/usr/bin/env node
// Dump one 0.x board to JSON, read by the 0.x store itself (DD-013), for
// `PmBoard.Api import`. The board is copied to a temp folder first, because
// the 0.x store creates missing folders when it loads, and this must never
// change the real repo.
//
//   node export-v0.mjs <folder with pm.config.json> [--slug <slug>] > board.json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { openV0Board } from './v0-board.mjs';

const args = process.argv.slice(2);
const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
let board;
try {
  board = await openV0Board(args.find((a) => !a.startsWith('--')) ?? '.');
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { src, store, version } = board;
const { getConfig } = board.config;
const work = board.work;
const rel = board.dataDir.slice(work.length + 1);
const data = store.load();
const archive = store.getArchive();
const quarantined = store.getQuarantined();

// Files next to the data that the 0.x store never reads (for example the
// *.tests.json catalogue files). Listed so the report can say what was left out.
const notRead = [];
for (const col of readdirSync(join(work, rel), { withFileTypes: true })) {
  if (!col.isDirectory() || col.name.startsWith('.')) continue;
  for (const f of readdirSync(join(work, rel, col.name))) {
    const json = ['plans', 'sprints', 'milestones'].includes(col.name);
    const read = json ? f.endsWith('.json') : f.endsWith('.md');
    if (!read && !f.endsWith('.tests.json')) notRead.push(`${col.name}/${f}`);
  }
}

// The 0.x read API merges `tests` from these files into decisions (items/DD-*.tests.json)
// and designs (designs/SDD-*.tests.json), so they are part of what a board shows.
const sidecarTests = {};
for (const col of ['items', 'designs']) {
  const dir = join(work, rel, col);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tests.json'))) {
    const id = f.replace(/\.tests\.json$/, '');
    if (col === 'items' && !id.startsWith('DD-')) continue; // 0.x reads them for DD only
    try {
      sidecarTests[id] = JSON.parse(readFileSync(join(dir, f), 'utf8')).tests ?? [];
    } catch {
      /* 0.x ignores a sidecar it cannot read */
    }
  }
}

const config = getConfig();
const keep = ['stages', 'entityTypes', 'claimTtlHours', 'commands', 'knowledgeBase', 'templates', 'frontend'];

// A board's own prompt templates (config.templates, a folder of <name>.md). 0.x read them from the
// repo; the server keeps them in the board's config, as templateFiles (DD-017).
const templateFiles = {};
if (config.templates) {
  const dir = resolve(src, config.templates);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      templateFiles[f.replace(/\.md$/, '')] = readFileSync(join(dir, f), 'utf8');
    }
  }
}

// Images that records link to: 0.x kept them in <dataDir>/../attachments (DD-018).
const attachments = [];
const attachmentsDir = join(resolve(src, rel), '..', 'attachments');
if (existsSync(attachmentsDir)) {
  for (const f of readdirSync(attachmentsDir).sort()) {
    if (f.startsWith('.')) continue;
    attachments.push({ name: f, data: readFileSync(join(attachmentsDir, f)).toString('base64') });
  }
}

const dump = {
  format: 'pm-v0-export',
  exportedWith: version,
  source: src,
  board: {
    slug: slugArg ?? basename(src),
    name: config.name ?? basename(src),
    config: {
      ...Object.fromEntries(keep.filter((k) => k in config).map((k) => [k, config[k]])),
      ...(Object.keys(templateFiles).length ? { templateFiles } : {}),
    },
  },
  items: data.items,
  designs: data.designs,
  plans: data.plans,
  sprints: data.sprints,
  milestones: data.milestones,
  archive: { items: archive.items, designs: archive.designs, archivedAt: archive.archivedAt },
  quarantined,
  sidecarTests,
  notRead,
  attachments,
};

board.close();
process.stdout.write(JSON.stringify(dump, null, 2) + '\n');
// The 0.x events module keeps a keepalive timer running.
process.exit(0);
