#!/usr/bin/env node
// Golden check of the exporter (DD-022). It imports a 0.x fixture, changes it through the API with
// awkward text (quotes, colons, YAML words, `---` in a body, unicode, newlines), sidecar tests, an
// attachment and an archived record, then runs `PmBoard.Api export`. tools/compare-read.mjs reads
// the exported folder with 0.x's own code and compares every read route with the server: the
// export must be the board the server serves. A second export must be byte for byte the same.
//
//   PMB_PG=postgres://user:pass@host:port/db node tools/compare-export.mjs [<fixture folder>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startV1Board } from './v1-board.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fixture = process.argv[2] ?? here('./fixtures/write-board');
const pgUrl = process.env.PMB_PG;
if (!pgUrl) {
  console.error('set PMB_PG to a Postgres connection string (the board is imported there under a new slug)');
  process.exit(2);
}

const slug = `export-golden-${Date.now().toString(36)}`;
const v1 = await startV1Board({ fixture, slug, pgUrl });
let failures = 0;

async function send(method, path, body, type = 'application/json') {
  const r = await fetch(`${v1.base}/api/boards/${slug}${path}`, {
    method,
    headers: { authorization: `Bearer ${v1.token}`, 'content-type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });
  if (!r.ok) {
    console.log(`FAIL  ${method} ${path}: ${r.status} ${await r.text()}`);
    failures++;
  }
  return r.ok ? r.json() : null;
}

const awkward = [
  'yes', 'null', 'true', '~', '- a list?', 'key: value', '# not a comment', '"quoted"', "it's", '  leading spaces',
  'trailing spaces  ', '@at', '`tick`', '{ brace', '[bracket', '*star', '&amp', '!bang', '%percent', '|pipe', '>fold',
  'tab\there', 'ünïcödé · 東京 · 🚀', 'line one\nline two', 'back\\slash', '0123', '1e5', '0x1F', '2026-01-01',
  'ends with colon:', 'SB-001',
];
const item = await send('POST', '/items', { type: 'issue', title: awkward.join(' | '), body: '---\nnot: frontmatter\n---\n\n# A heading\n\n- a list\n', priority: 'high' });
for (const text of awkward) await send('POST', `/items/${item.id}/comments`, { text, author: text.trim() || 'x' });
await send('PATCH', `/items/${item.id}`, { related: 'SB-001,SB-002', affectedFiles: 'a: b.js,c.js', pillar: 'yes' });
await send('POST', '/items', { type: 'term', title: 'no', body: 'A word that YAML 1.1 reads as false.', aliases: ['off', 'n'] });
await send('POST', '/items', { type: 'decision', title: 'A decision with tests' });
await send('PUT', '/tests', { tests: { 'DD-003': [{ name: 'a: test', file: 'x.test.js', claims: ['DD-003'] }], 'SDD-001': [{ name: 'design test' }] } });
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const { filename } = await send('POST', '/attachments?name=upload.png', image, 'image/png');
await send('PATCH', '/items/SB-003', { stage: 'done' });
await send('POST', '/items/archive', { ids: ['SB-003'] });
await send('POST', '/plans', { title: 'Plan: "quoted"', tasks: [{ title: 'yes' }, { title: 'B', blockedBy: ['Task 1'], steps: ['- one', 'two: 2'] }] });
await send('POST', '/sprints', { name: 'null', problemStatement: 'A project named null' });

const work = mkdtempSync(join(tmpdir(), 'pm-export-'));
for (const out of ['a', 'b']) {
  const r = v1.dotnet('export', join(work, out), '--board', slug);
  if (r.status !== 0) throw new Error(`export failed: ${r.stdout}\n${r.stderr}`);
}

// 0.x reads the export, and every read route must equal the server's.
const cmp = spawnSync(process.execPath, [here('./compare-read.mjs'), join(work, 'a', slug), slug, v1.base], { encoding: 'utf8' });
process.stdout.write(cmp.stdout.split('\n').filter((l) => !l.startsWith('same')).join('\n'));
if (cmp.status !== 0) failures++;

// The files that must be there.
const root = join(work, 'a', slug);
// DD-001 lost its tests in the PUT, which sets the whole catalogue (DD-019).
for (const f of ['pm.config.json', 'data/items/DD-003.tests.json', 'data/designs/SDD-001.tests.json', 'data/archive/SB-003.md', 'data/archive/SB-005.md', 'templates/prompt-item.md', 'data/plans/PLAN-003.json']) {
  if (!existsSync(join(root, f))) {
    console.log(`FAIL  ${f} is missing`);
    failures++;
  }
}

if (existsSync(join(root, 'data/items/DD-001.tests.json'))) {
  console.log('FAIL  data/items/DD-001.tests.json is there, but the PUT removed its tests');
  failures++;
}
// Every attachment, byte for byte as the server serves it: the fixture's and the new one.
for (const name of ['0123456789ab.png', filename]) {
  const served = Buffer.from(await (await fetch(`${v1.base}/attachments/${name}`)).arrayBuffer());
  const file = join(root, 'attachments', name);
  if (!existsSync(file) || !readFileSync(file).equals(served)) {
    console.log(`FAIL  attachments/${name} is not what the server serves`);
    failures++;
  }
}

// The same data gives the same files, so an export with no change makes no commit.
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
const [fa, fb] = [files(join(work, 'a')), files(join(work, 'b'))];
const changed = fa.length !== fb.length ? ['(file list)'] : fa.filter((f, i) => f !== fb[i] || !readFileSync(join(work, 'a', f)).equals(readFileSync(join(work, 'b', f))));
console.log(`${changed.length ? 'FAIL' : 'same'}  a second export: ${changed.length ? changed.slice(0, 3).join(', ') : `${fa.length} files, byte for byte`}`);
if (changed.length) failures++;

v1.close();
rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} failures` : 'export: no differences');
process.exit(failures ? 1 : 0);
