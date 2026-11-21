#!/usr/bin/env node
// Golden check of the read API: every 0.x read route, answered by 0.x itself
// (lib/dispatch.js on a temp copy of the board), against the same route on a
// 1.x server that has imported that board. Compared as data, not as text.
//
//   node compare-read.mjs <board folder> <slug> <1.x base URL>
//
// Differences that are known and wanted are not counted (see `same` below and
// server/docs/data-model.md): null versus a missing field, the order of keys,
// times written in another ISO form, and records that the importer renumbered.
import { openV0Board } from './v0-board.mjs';

import { readFileSync, existsSync } from 'node:fs';

const [folder, slug, base = 'http://localhost:5055', reportPath] = process.argv.slice(2);
if (!folder || !slug) {
  console.error('usage: compare-read.mjs <board folder> <slug> [<1.x base URL>] [<import report>]');
  process.exit(2);
}

// The importer's own changes, from its report: a dropped copy is missing in 1.x on purpose, and a
// renumbered record has its new key where 0.x has the old one.
const dropped = new Set();
const renumbered = new Map();
if (reportPath && existsSync(reportPath)) {
  for (const c of JSON.parse(readFileSync(reportPath, 'utf8')).Clashes) {
    const to = /^renumbered to ([^;]+)/.exec(c.Action)?.[1];
    if (to) renumbered.set(c.Key, [...(renumbered.get(c.Key) ?? []), to]);
    else dropped.add(c.Key);
  }
}
const board = await openV0Board(folder);

async function v0(path) {
  const r = await board.dispatch('GET', '/api' + path);
  return r.status === 200 ? r.data : { status: r.status };
}
async function v1(path) {
  const r = await fetch(`${base}/api/boards/${slug}${path}`);
  return r.ok ? r.json() : { status: r.status };
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
const empty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** The first difference between a (0.x) and b (1.x), as a path, or null when they are the same. */
function diff(a, b, path = '') {
  if (empty(a) && empty(b)) return null;
  if ((path.endsWith('.id') || /blockedBy\[\d+\]$/.test(path)) && renumbered.get(a)?.includes(b)) return null;
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
    return Date.parse(a) === Date.parse(b) ? null : { path, a, b };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path: path + '.length', a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      // A comment that had no id in 0.x gets one in 1.x.
      if (k === 'id' && path.includes('comments') && a[k] === undefined) continue;
      const d = diff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : { path, a, b };
}

/** Compare two lists of records by id. 0.x ids that appear twice are the clashes the importer reported. */
function compareLists(name, a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return report(name, 1, [{ path: '', a, b }], 0, 0);
  const count = new Map();
  for (const x of a) count.set(x.id, (count.get(x.id) ?? 0) + 1);
  const byId = new Map(b.map((x) => [x.id, x]));
  const diffs = [];
  let same = 0;
  let clashes = 0;
  for (const x of a) {
    if (count.get(x.id) > 1) {
      clashes++;
      continue;
    }
    const y = byId.get(x.id) ?? (renumbered.get(x.id) ?? []).map((k) => byId.get(k)).find(Boolean);
    if (!y && (dropped.has(x.id) || renumbered.has(x.id))) {
      clashes++;
      continue;
    }
    const d = y ? diff(x, y, x.id) : { path: x.id, a: 'present', b: 'missing' };
    if (d) diffs.push(d);
    else same++;
  }
  const ids = new Set(a.map((x) => x.id));
  const renumberedTo = new Set([...renumbered.values()].flat());
  const onlyV1 = b.filter((y) => !ids.has(y.id) && !renumberedTo.has(y.id)).length;
  if (onlyV1) diffs.push({ path: '', a: `${onlyV1} fewer`, b: `${onlyV1} records only in 1.x` });
  report(name, a.length, diffs, same, clashes);
  return diffs.length;
}

let failures = 0;
function report(name, total, diffs, same, clashes = 0) {
  const extra = clashes ? `${clashes} clashes the importer reported` : '';
  console.log(`${diffs.length ? 'DIFF' : 'same'}  ${name}: ${same}/${total} the same${extra ? ` (${extra})` : ''}`);
  for (const d of diffs.slice(0, 3)) {
    console.log(`      ${d.path}: 0.x ${JSON.stringify(d.a)?.slice(0, 100)}  1.x ${JSON.stringify(d.b)?.slice(0, 100)}`);
  }
  failures += diffs.length;
}

console.log(`${slug}: 0.x ${board.version} against ${base}`);

// 0.x's /api/config lives in the Express app only, not in the dispatcher: build it the same way.
const c0 = board.config.getConfig();
const cfgA = { name: c0.name, stages: c0.stages, entityTypes: c0.entityTypes, commands: c0.commands || {} };
const cfgB = await v1('/config');
const cfgD = diff(cfgA, Object.fromEntries(Object.keys(cfgA).map((k) => [k, cfgB[k]])));
report('config', 1, cfgD ? [cfgD] : [], cfgD ? 0 : 1);

for (const path of [
  '/items',
  '/items?frontier=true',
  '/items?frontier=true&allClaims=true',
  '/items?type=decision',
  '/items?type=term',
  '/items?stage=inbox',
  '/items/archived',
  '/designs',
  '/plans',
  '/sprints',
]) {
  compareLists(path, await v0(path), await v1(path));
}

// One record at a time, the way `pm get` and the detail views read them.
const singles = { items: await v0('/items'), designs: await v0('/designs'), plans: await v0('/plans'), sprints: await v0('/sprints') };
for (const [kind, list] of Object.entries(singles)) {
  const dup = new Set(list.filter((x, i) => list.findIndex((y) => y.id === x.id) !== i).map((x) => x.id));
  const a = [];
  const b = [];
  for (const { id } of list.filter((x) => !dup.has(x.id))) {
    a.push(await v0(`/${kind}/${encodeURIComponent(id)}`));
    const one = await v1(`/${kind}/${encodeURIComponent(id)}`);
    b.push(one.id ? one : { ...one, id });
  }
  compareLists(`/${kind}/{id} one by one`, a, b);
}

// The routes that compute an answer from many records: per plan, per project, and the prompt and
// review texts of every record that has one. explore and suggest are POST in 0.x but change nothing.
async function computed(name, calls) {
  let same = 0;
  const diffs = [];
  for (const [method, path, body] of calls) {
    const a = await board.dispatch(method, '/api' + path, structuredClone(body));
    const r = await fetch(`${base}/api/boards/${slug}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const b = { status: r.status, data: await r.json() };
    // The knowledge base runs in the CLI (DD-017); 0.x's is switched off below for these.
    if (b.data && typeof b.data === 'object') delete b.data.qmdQueries;
    // A text that names a renumbered task has its new key where 0.x has the old one.
    b.data = oldKeys(b.data);
    const d = a.status !== b.status ? { path, a: a.status, b: b.status } : diff(a.data, b.data, path);
    if (d) diffs.push(d);
    else same++;
  }
  report(name, calls.length, diffs, same);
}
const back = new Map([...renumbered].flatMap(([old, tos]) => tos.map((to) => [to, old])));
const backRe = back.size ? new RegExp(`\\b(${[...back.keys()].join('|')})\\b`, 'g') : null;
function oldKeys(v) {
  if (!backRe) return v;
  if (typeof v === 'string') return v.replace(backRe, (k) => back.get(k));
  if (Array.isArray(v)) return v.map(oldKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, oldKeys(x)]));
  return v;
}
const plans = singles.plans.map((p) => p.id).filter((id, i, all) => all.indexOf(id) === i);
await computed('/plans/{id}/next-task and /context', plans.flatMap((id) => [['GET', `/plans/${id}/next-task`], ['GET', `/plans/${id}/context`]]));
await computed('/sprints/{id}/explore and /suggest', singles.sprints.flatMap(({ id }) => [['POST', `/sprints/${id}/explore`, {}], ['POST', `/sprints/${id}/suggest`, {}]]));
// 0.x runs the knowledge-base command for these: switch it off on the 0.x side.
c0.knowledgeBase = { ...c0.knowledgeBase, command: null };
const unique = (list) => list.map((x) => x.id).filter((id, i, all) => all.indexOf(id) === i && !renumbered.has(id) && !dropped.has(id));
await computed('/context/prompt for every item, design and plan', [
  ...unique(singles.items).map((id) => ['POST', '/context/prompt', { entityType: 'item', entityId: id }]),
  ...unique(singles.designs).map((id) => ['POST', '/context/prompt', { entityType: 'sdd', entityId: id }]),
  ...unique(singles.plans).map((id) => ['POST', '/context/prompt', { entityType: 'plan', entityId: id }]),
]);
await computed('/context/review for every design and plan', [
  ...unique(singles.designs).map((id) => ['POST', '/context/review', { entityType: 'sdd', entityId: id }]),
  ...unique(singles.plans).map((id) => ['POST', '/context/review', { entityType: 'plan', entityId: id }]),
]);

board.close();
console.log(failures ? `${failures} differences` : 'no differences');
process.exit(failures ? 1 : 0);
