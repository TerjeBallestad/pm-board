#!/usr/bin/env node
// Golden check of the server's glossary match (DD-029) on a real board: for every item, design,
// plan, project and task, the text pm get scans goes to POST .../glossary/match, and the answer
// must be what shared/glossary.js finds in it with the board's terms.
//
//   node tools/compare-glossary.mjs <server url> <slug>
import { buildTermIndex, findTermMatches, firstMatchPerTerm } from '../shared/glossary.js';

const [base, slug] = process.argv.slice(2);
if (!base || !slug) {
  console.error('usage: node tools/compare-glossary.mjs <server url> <slug>');
  process.exit(2);
}
const url = (path) => `${base.replace(/\/+$/, '')}/api/boards/${encodeURIComponent(slug)}${path}`;
const get = async (path) => (await fetch(url(path))).json();

const terms = await get('/items?type=term');
const index = buildTermIndex(terms);
const plans = await get('/plans');
const records = [
  ...(await get('/items')),
  ...(await get('/designs')),
  ...plans,
  ...plans.flatMap((p) => p.tasks || []),
  ...(await get('/sprints')),
];

// The text pm get scans (cli/lib/output.js printGlossaryFooter).
const scanned = (e) =>
  [e.title || e.name || '', e.body || e.description || '', ...(Array.isArray(e.comments) ? e.comments.map((c) => c?.text || '') : [])].join('\n');
const shape = (m) => ({ termId: m.termId, title: m.title, kind: m.kind, targets: m.targets, targetTitles: m.targetTitles, text: m.text });

let differences = 0;
let mentions = 0;
for (const r of records) {
  const text = scanned(r);
  const want = JSON.stringify(firstMatchPerTerm(findTermMatches(text, index)).map(shape));
  const res = await fetch(url('/glossary/match'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const got = JSON.stringify(await res.json());
  mentions += JSON.parse(want).length;
  if (got !== want) {
    differences++;
    console.log(`DIFF  ${r.id}\n      js:     ${want.slice(0, 300)}\n      server: ${got.slice(0, 300)}`);
  }
}
console.log(
  differences
    ? `${differences} differences`
    : `no differences (${records.length} records, ${terms.length} terms, ${mentions} mentions)`,
);
process.exit(differences ? 1 : 0);
