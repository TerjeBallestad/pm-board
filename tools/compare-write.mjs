#!/usr/bin/env node
// Golden check of the write API. One script of requests runs against 0.x (lib/dispatch.js on a temp
// copy of a fixture board) and against 1.x (the same board, exported and imported under a new slug).
// After every step it compares the step's answer and then every read route, as data, with
// compare-read's rules, plus two for writes: a time or comment id made during the run only has to be
// new on both sides, and a time inside a text counts as the same when both are new.
//
//   PMB_PG=postgres://user:pass@host:port/db node tools/compare-write.mjs [<fixture folder>] [--base <url>]
//
// It imports the fixture with `PmBoard.Api import` into PMB_PG (a new board each run, nothing is
// wiped) and starts the server on a free port, unless --base points at one that uses the same
// database. Build the server first (dotnet build server/PmBoard.slnx).
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openV0Board } from './v0-board.mjs';
import { appendPromptKnowledge, appendReviewKnowledge } from '../shared/knowledge-base.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const fixture = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--base') ?? here('./fixtures/write-board');
const pgUrl = process.env.PMB_PG;
if (!pgUrl) {
  console.error('set PMB_PG to a Postgres connection string (the board is imported there under a new slug)');
  process.exit(2);
}

const start = Date.now();
const slug = `write-golden-${start.toString(36)}`;
const u = new URL(pgUrl);
const npgsql = `Host=${u.hostname};Port=${u.port || 5432};Database=${u.pathname.slice(1)};Username=${decodeURIComponent(u.username)};Password=${decodeURIComponent(u.password)}`;
const env = { ...process.env, ConnectionStrings__pmboard: npgsql, Logging__LogLevel__Default: 'Warning' };
const project = here('../server/src/PmBoard.Api');

// --- 1.x: export the fixture with the 0.x code, import it, start a server ---
const work = mkdtempSync(join(tmpdir(), 'pm-compare-write-'));
const dumpPath = join(work, 'dump.json');
const exp = spawnSync(process.execPath, [here('./export-v0.mjs'), fixture, '--slug', slug], { encoding: 'utf8', maxBuffer: 1 << 28 });
if (exp.status !== 0) throw new Error(`export failed: ${exp.stderr}`);
writeFileSync(dumpPath, exp.stdout);
const imp = spawnSync('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project, '--', 'import', dumpPath], { env, encoding: 'utf8' });
if (imp.status !== 0) throw new Error(`import failed: ${imp.stdout}\n${imp.stderr}`);

let server = null;
let base = baseArg;
if (!base) {
  const port = 5300 + Math.floor(Math.random() * 600);
  base = `http://localhost:${port}`;
  server = spawn('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project], {
    env: { ...env, ASPNETCORE_URLS: base },
    stdio: ['ignore', process.env.PMB_SERVER_LOG ? 'inherit' : 'ignore', 'inherit'],
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error('the server did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// --- 0.x: the same fixture, a temp copy ---
const board = await openV0Board(fixture);
const runKb = (q) => {
  const cmd = board.config.buildQmdCommand(q);
  if (!cmd) return null;
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf8' });
  } catch {
    return null;
  }
};

async function v0(method, path, body) {
  const r = await board.dispatch(method, '/api' + path, body);
  return { status: r.status, data: r.data };
}
async function v1(method, path, body) {
  const r = await fetch(`${base}/api/boards/${slug}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = text ? JSON.parse(text) : undefined;
  // The CLI runs the knowledge-base queries (DD-017); do here what it does.
  if (data?.qmdQueries && path === '/context/prompt') data = appendPromptKnowledge(data, runKb);
  if (data?.qmdQueries && path === '/context/review') data = appendReviewKnowledge(data, runKb);
  return { status: r.status, data };
}

// --- comparison: compare-read's rules, and new values on both sides ---
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const ISO_IN_TEXT = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const isNewTime = (s) => Date.parse(s) >= start - 1000;
const isNewCommentId = (s) => /^c\d+$/.test(s) && Number(s.slice(1)) >= start - 1000;
const empty = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
const textTimes = (s) => s.replace(ISO_IN_TEXT, (t) => (isNewTime(t) ? '<new time>' : t));

/**
 * The first difference between a (0.x) and b (1.x), or null. pa and pb are the same value after the
 * step before: a new time or comment id passes only when both sides changed it in this step, or
 * neither did.
 */
function diff(a, b, path = '', pa, pb) {
  if (empty(a) && empty(b)) return null;
  if (typeof a === 'string' && typeof b === 'string') {
    const sameChange = (a === pa) === (b === pb);
    if (a === b) return null;
    if (ISO.test(a) && ISO.test(b)) {
      return Date.parse(a) === Date.parse(b) || (isNewTime(a) && isNewTime(b) && sameChange) ? null : { path, a, b };
    }
    if (path.endsWith('.id') && isNewCommentId(a) && isNewCommentId(b) && sameChange) return null;
    return textTimes(a) === textTimes(b) ? null : { path, a, b };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path: path + '.length', a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`, pa?.[i], pb?.[i]);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diff(a[k], b[k], `${path}.${k}`, pa?.[k], pb?.[k]);
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : { path, a, b };
}

/** Lists compare by id, as in compare-read: the order of files on disk is not a contract. */
function diffList(a, b, path, pa, pb) {
  if (!Array.isArray(a) || !Array.isArray(b)) return diff(a, b, path, pa, pb);
  const byId = new Map(b.map((x) => [x.id, x]));
  const prevA = new Map((Array.isArray(pa) ? pa : []).map((x) => [x.id, x]));
  const prevB = new Map((Array.isArray(pb) ? pb : []).map((x) => [x.id, x]));
  for (const x of a) {
    const d = byId.has(x.id)
      ? diff(x, byId.get(x.id), `${path}/${x.id}`, prevA.get(x.id), prevB.get(x.id))
      : { path: `${path}/${x.id}`, a: 'present', b: 'missing' };
    if (d) return d;
  }
  const ids = new Set(a.map((x) => x.id));
  const extra = b.filter((y) => !ids.has(y.id)).map((y) => y.id);
  return extra.length ? { path, a: 'missing', b: extra } : null;
}

/** What each read route answered after the step before, on each side. */
const previous = new Map();

/** Every read route, on both sides. Returns the first difference. */
async function compareReads() {
  const seen = new Map();
  const check = async (p, list) => {
    const a = await v0('GET', p);
    const b = await v1('GET', p);
    seen.set(p, [a.data, b.data]);
    const [pa, pb] = previous.get(p) ?? [];
    if (a.status !== b.status) return { path: p, a: a.status, b: b.status };
    return list ? diffList(a.data, b.data, p, pa, pb) : diff(a.data, b.data, p, pa, pb);
  };
  let d = null;
  for (const p of ['/items', '/items?frontier=true', '/items?frontier=true&allClaims=true', '/items?type=decision', '/items/archived', '/designs', '/plans', '/sprints']) {
    d ??= await check(p, true);
  }
  for (const kind of ['items', 'designs', 'plans', 'sprints']) {
    for (const { id } of (await v0('GET', `/${kind}`)).data) {
      d ??= await check(`/${kind}/${id}`, false);
      if (kind === 'plans') {
        d ??= await check(`/plans/${id}/next-task`, false);
        d ??= await check(`/plans/${id}/context`, false);
      }
    }
  }
  previous.clear();
  for (const [k, v] of seen) previous.set(k, v);
  return d;
}

// --- the script ---
// Keys are written out: both sides must give the same ones. The fixture's highest keys are SB-005
// (archived), DD-002, TERM-001, SDD-001, PLAN-002, TASK-004 and SPRINT-001.
// A step with `differs` is a change from 0.x that a DD describes: only 1.x's status is checked.
const A = 'TASK-005';
const B = 'TASK-006';
const steps = [
  // items: create
  ['POST', '/items', { type: 'issue', title: 'New issue', body: 'Body text', priority: 'high', related: 'SB-001' }],
  ['POST', '/items', { title: 'No type and no body' }],
  ['POST', '/items', { type: 'decision', title: 'A new decision', stage: 'exploring', sprintId: 'SPRINT-001' }],
  ['POST', '/items', { type: 'term', title: 'Token', aliases: ['tokens'], stage: 'not-a-stage' }],
  ['POST', '/items', { type: 'bogus', title: 'Unknown type' }],
  ['POST', '/items', { type: 'issue' }],
  // items: patch
  ['PATCH', '/items/SB-006', { stage: 'exploring', related: 'SB-001, SB-002', affectedFiles: '', pillar: 'auth', blockedBy: 'SB-002' }],
  ['PATCH', '/items/SB-006', { stage: 'nope' }],
  ['PATCH', '/items/SB-404', { title: 'x' }],
  ['PATCH', '/items/SB-007', { body: '' }],
  ['PATCH', '/items/SB-007', { body: 'Now with a body', priority: null, sprintId: 'SPRINT-001' }],
  ['PATCH', '/items/SB-002', { assignee: 'agent-a' }],
  ['PATCH', '/items/SB-002', { assignee: '' }],
  ['PATCH', '/items/TERM-001', { aliases: 'the-session,sessions' }],
  // claims
  ['POST', '/items/SB-001/claim', { assignee: 'agent-a' }],
  ['POST', '/items/SB-001/claim', { assignee: 'agent-b' }],
  ['POST', '/items/SB-001/claim', { assignee: 'agent-a' }],
  ['POST', '/items/SB-001/claim', {}],
  ['POST', '/items/SB-003/claim', { assignee: 'agent-b' }],
  ['POST', '/items/SB-004/claim', { assignee: 'agent-b' }],
  ['POST', '/items/SB-404/claim', { assignee: 'agent-b' }],
  ['POST', '/items/SB-001/release', {}],
  ['POST', '/items/SB-404/release', {}],
  // comments
  ['POST', '/items/SB-001/comments', { text: 'A comment', author: 'agent-a' }],
  ['POST', '/items/SB-001/comments', { text: 'Second, no author' }],
  ['POST', '/items/SB-001/comments', { author: 'agent-a' }],
  ['POST', '/items/SB-404/comments', { text: 'x' }],
  // done, archive, sweep
  ['PATCH', '/items/SB-004', { stage: 'done' }],
  ['PATCH', '/items/SB-004', { stage: 'done', title: 'Done twice keeps the first doneAt' }],
  ['POST', '/items/archive', { ids: ['SB-004', 'SB-404', 'SB-004'] }],
  ['POST', '/items/archive', {}],
  ['POST', '/items/archive/sweep', { days: 30 }],
  ['POST', '/items/archive/sweep', {}],
  // designs
  ['POST', '/designs', { title: 'Session design', itemIds: ['SB-002', 'SB-404', 'DD-002'], sprintId: 'SPRINT-001', body: 'Design body' }],
  ['POST', '/designs', { body: 'no title' }],
  ['PATCH', '/designs/SDD-002', { stage: 'planned', itemIds: 'SB-002' }],
  ['PATCH', '/designs/SDD-002', { body: '' }],
  ['PATCH', '/designs/SDD-404', { stage: 'planned' }],
  ['POST', '/designs/SDD-002/comments', { text: 'Design note' }],
  ['POST', '/designs/SDD-404/comments', { text: 'x' }],
  // plans
  ['POST', '/plans', { title: 'Session plan', sddId: 'SDD-002', sprintId: 'SPRINT-001', tasks: [{ title: 'A' }, { title: 'B', blockedBy: ['Task 1'] }, { title: 'C', blockedBy: [1, '#2'], steps: ['one'], passes: true, status: 'done' }] }],
  ['POST', '/plans', { title: 'Refused plan', tasks: [{ title: 'A', blockedBy: ['Task 7'] }] }],
  ['POST', '/plans', { tasks: [] }],
  ['POST', '/plans', { title: 'A plan with no tasks' }],
  ['POST', `/plans/PLAN-003/tasks`, { tasks: [{ title: 'D', blockedBy: ['Task 3'], description: 'Fourth' }] }],
  ['POST', `/plans/PLAN-003/tasks`, { tasks: [] }],
  ['POST', `/plans/PLAN-002/tasks`, { tasks: [{ title: 'X' }] }],
  ['POST', `/plans/PLAN-404/tasks`, { tasks: [{ title: 'X' }] }],
  ['PATCH', `/plans/PLAN-003/tasks/${A}`, { status: 'in_progress', progressNote: 'started' }],
  ['PATCH', `/plans/PLAN-003/tasks/${A}`, { passes: true, progressNote: 'done in abc123' }],
  ['PATCH', `/plans/PLAN-003/tasks/${B}`, { description: 'New description', steps: ['s1', 's2'], verification: 'check it', passes: false }],
  ['PATCH', `/plans/PLAN-404/tasks/${A}`, { status: 'done' }],
  ['PATCH', `/plans/PLAN-003/tasks/TASK-404`, { status: 'done' }],
  ['POST', '/plans/PLAN-003/comments', { text: 'Plan comment', author: 'me' }],
  ['POST', '/plans/PLAN-003/comments', {}],
  ['PATCH', '/plans/PLAN-003', { title: 'Session plan v2', stage: 'in_progress', context: { setupNotes: 'Notes', relevantFiles: ['a.js'], designDecisions: ['DD-001 cookies', 'DD-003'] } }],
  ['PATCH', '/plans/PLAN-404', { title: 'x' }],
  // a full replacement: B and A keep their keys, notes and status; E is new; C and D go
  async () => {
    // Built from the plan as 0.x has it now; both sides get the same body.
    const byId = Object.fromEntries((await v0('GET', '/plans/PLAN-003')).data.tasks.map((t) => [t.id, t]));
    return ['PATCH', '/plans/PLAN-003', { tasks: [byId[B], { title: 'E', blockedBy: [B, 'Task 3'] }, byId[A]] }];
  },
  ['PATCH', '/plans/PLAN-003', { tasks: [{ title: 'Z', blockedBy: ['nope'] }] }],
  // projects (sprints)
  ['POST', '/sprints', { name: 'Second project', problemStatement: 'Tokens and sessions everywhere' }],
  ['POST', '/sprints', { problemStatement: 'no name' }],
  ['POST', '/sprints/SPRINT-002/items', { itemIds: ['SB-001', 'SB-404', 'TERM-002', 'SB-006'] }],
  ['POST', '/sprints/SPRINT-002/items', {}],
  ['POST', '/sprints/SPRINT-404/items', { itemIds: [] }],
  ['POST', '/sprints/SPRINT-002/comments', { text: 'Project comment' }],
  ['POST', '/sprints/SPRINT-001/suggest', {}],
  ['POST', '/sprints/SPRINT-002/suggest', {}],
  ['POST', '/sprints/SPRINT-001/explore', {}],
  ['POST', '/sprints/SPRINT-002/explore', {}],
  ['POST', '/sprints/SPRINT-404/explore', {}],
  ['PATCH', '/sprints/SPRINT-002', { problemStatement: 'Tokens', body: 'The project doc' }],
  ['PATCH', '/sprints/SPRINT-002', { status: 'completed' }],
  ['PATCH', '/sprints/SPRINT-404', { status: 'completed' }],
  // prompts and reviews
  ['POST', '/context/prompt', { entityType: 'item', entityId: 'SB-001' }],
  ['POST', '/context/prompt', { entityType: 'item', entityId: 'GAP-001', includeQmd: true }],
  ['POST', '/context/prompt', { entityType: 'sdd', entityId: 'SDD-001' }],
  ['POST', '/context/prompt', { entityType: 'plan', entityId: 'PLAN-001' }],
  ['POST', '/context/prompt', { entityType: 'plan', entityId: 'PLAN-003', includeQmd: true }],
  ['POST', '/context/prompt', { entityType: 'item', entityId: 'SB-404' }],
  ['POST', '/context/prompt', { entityType: 'bogus', entityId: 'SB-001' }],
  ['POST', '/context/review', { entityType: 'sdd', entityId: 'SDD-001' }],
  ['POST', '/context/review', { entityType: 'sdd', entityId: 'SDD-002' }],
  ['POST', '/context/review', { entityType: 'plan', entityId: 'PLAN-001' }],
  ['POST', '/context/review', { entityType: 'plan', entityId: 'PLAN-003' }],
  ['POST', '/context/review', { entityType: 'plan', entityId: 'PLAN-404' }],
  ['POST', '/context/review', { entityType: 'item', entityId: 'SB-001' }],
  // deletes, last: 0.x hands a deleted highest key out again, 1.x never does (DD-011)
  ['DELETE', '/items/SB-006'],
  ['DELETE', '/items/SB-006'],
  // changes from 0.x (DD-016): an unknown field, and a task key that another record has
  { differs: 'DD-016', step: ['PATCH', '/items/SB-001', { prioritty: 'high' }], v1: 400 },
  ['PATCH', '/items/SB-001', { priority: 'low' }],
  { differs: 'DD-016', step: ['PATCH', `/plans/PLAN-003/tasks/${B}`, { title: 'not a task field' }], v1: 400 },
  ['PATCH', `/plans/PLAN-003/tasks/${B}`, { status: 'pending' }],
  { differs: 'DD-016', last: true, step: ['PATCH', '/plans/PLAN-003', { tasks: [{ id: 'TASK-001', title: 'Another plan\'s key' }] }], v1: 400 },
];

let failures = 0;
let compared = 0;
const show = (v) => JSON.stringify(v)?.slice(0, 160);
console.log(`${slug}: 0.x ${board.version} against ${base}`);

let d = await compareReads();
if (d) {
  console.log(`DIFF  before the first step ${d.path}: 0.x ${show(d.a)}  1.x ${show(d.b)}`);
  failures++;
}

for (let i = 0; i < steps.length; i++) {
  const step = typeof steps[i] === 'function' ? await steps[i]() : steps[i];
  if (step.differs) {
    const b = await v1(...structuredClone(step.step));
    const ok = b.status === step.v1;
    console.log(`${ok ? 'ok  ' : 'DIFF'}  ${step.step[0]} ${step.step[1]}: 1.x ${b.status} (${step.differs}) ${show(b.data)}`);
    if (!ok) failures++;
    if (step.last) break;
    await v0(...step.step);
    continue;
  }
  const [method, path, body] = step;
  // 0.x changes the body it gets (coerceArrayField), so each side gets its own copy.
  const a = await v0(method, path, structuredClone(body));
  const b = await v1(method, path, structuredClone(body));
  compared++;
  let d = a.status !== b.status ? { path: 'status', a: `${a.status} ${show(a.data)}`, b: `${b.status} ${show(b.data)}` } : diff(a.data, b.data, 'answer');
  if (!d) d = await compareReads();
  console.log(`${d ? 'DIFF' : 'same'}  ${method} ${path} ${body ? show(body) : ''} -> ${a.status}`);
  if (d) {
    console.log(`      ${d.path}: 0.x ${show(d.a)}  1.x ${show(d.b)}`);
    failures++;
    break; // the boards differ from here on
  }
}

board.close();
server?.kill('SIGTERM');
rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} differences` : `no differences (${compared} steps, every read route after each)`);
process.exit(failures ? 1 : 0);
