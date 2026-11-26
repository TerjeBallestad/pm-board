#!/usr/bin/env node
// Golden check of the 1.x CLI (cli/bin/pm). One script of about 160 pm commands, in two modes.
//
// --expected (CI): each command runs with cli/bin/pm against a server that imported the fixture,
// and its exit code, stdout and stderr must equal its file in tools/fixtures/cli-expected/. From
// pm 1.1 a change of output needs a DD that says why (DD-024); --update rewrites the files, and
// the diff of the files is the change to review. What changes from run to run is masked: a time
// or comment id made during the run, the slug, the server URL and the temp folders. JSON is stored
// with sorted keys, as jsonb keeps no key order.
//
// Default: the same script runs with 0.x's bin/pm too, serverless on a temp copy of the fixture,
// and each command's exit code, stdout and stderr must be the same on both. JSON compares as data
// with compare-write's rules (golden-diff.mjs): jsonb keeps no key order, and a time made during
// the run only has to be new on both sides. Text compares as text, with new times masked. This
// mode needs 0.x (the tools/ package depends on it).
//
//   PMB_PG=postgres://user:pass@host:port/db node tools/compare-cli.mjs [--expected | --update] [<fixture folder>] [--base <url>]
//
// Like compare-write, it imports the fixture into PMB_PG under a new slug, mints a token and starts
// the server, unless --base points at one on the same database. Build the server first.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { startV1Board } from './v1-board.mjs';
import { makeDiff } from './golden-diff.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const update = args.includes('--update');
const expectedMode = update || args.includes('--expected');
const fixture = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--base') ?? here('./fixtures/write-board');
const expectedDir = here('./fixtures/cli-expected');
const pgUrl = process.env.PMB_PG;
if (!pgUrl) {
  console.error('set PMB_PG to a Postgres connection string (the board is imported there under a new slug)');
  process.exit(2);
}

const start = Date.now();
const slug = `cli-golden-${start.toString(36)}`;
const { diff, diffList, textTimes } = makeDiff(start);

// --- 1.x: the fixture on a server, and a repo folder with .pm.json ---
const v1Board = await startV1Board({ fixture, slug, pgUrl, base: baseArg });
const v1Dir = mkdtempSync(join(tmpdir(), 'pm-cli-v1-'));
writeFileSync(join(v1Dir, '.pm.json'), JSON.stringify({ board: slug }) + '\n');
const v1Bin = here('../cli/bin/pm');

// --- 0.x: a temp copy of the fixture folder, serverless; not in the expected mode ---
let v0Version = null;
let v0Bin = null;
let v0Dir = null;
if (!expectedMode) {
  const require = createRequire(import.meta.url);
  const v0Pkg = dirname(require.resolve('@terjeballestad/pm-board-cli/package.json'));
  v0Version = JSON.parse(readFileSync(join(v0Pkg, 'package.json'), 'utf8')).version;
  v0Bin = join(v0Pkg, 'bin', 'pm');
  v0Dir = mkdtempSync(join(tmpdir(), 'pm-cli-v0-'));
  cpSync(fixture, v0Dir, { recursive: true });
}

// Files the commands read (--body @file, @note), and a subfolder: both CLIs walk up to their config.
for (const dir of [v0Dir, v1Dir].filter(Boolean)) {
  writeFileSync(join(dir, 'body.md'), 'A body from a file.\n\nSecond paragraph.\n');
  writeFileSync(join(dir, 'note.md'), 'Done: see commit abc123.\n');
  mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
}

const baseEnv = { ...process.env };
for (const k of ['PM_URL', 'PM_TOKEN', 'CLAUDE_SESSION_ID']) delete baseEnv[k];
const v0Env = v0Dir && { ...baseEnv, PM_STATE_DIR: join(v0Dir, '.state') };
// XDG_CONFIG_HOME keeps this machine's ~/.config/pm/config.json out of the run.
const v1Env = { ...baseEnv, PM_URL: v1Board.base, PM_TOKEN: v1Board.token, XDG_CONFIG_HOME: join(v1Dir, '.config') };

function run(side, argv, { input, cwd = '' } = {}) {
  const [bin, dir, env] = side === 0 ? [v0Bin, v0Dir, v0Env] : [v1Bin, v1Dir, v1Env];
  const r = spawnSync(process.execPath, [bin, ...argv], { cwd: join(dir, cwd), env, input: input ?? '', encoding: 'utf8', timeout: 60000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** bodyHash (DD-030): the first 12 hex characters of the sha256 of the body as UTF-8. */
const hash = (body) => createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
// DD-003's body after the prepend and the two appends below, as the server joins blocks.
const dd003Joined = 'Superseded: read the block below.\n\nPatched through the shorthand\n\nA body from a file.\n\nSecond paragraph.\n\nFrom stdin.';

const parse = (s) => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};
const isIdList = (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'id' in x);

/** stdout: as data when both are JSON, else as text. */
function diffOut(a, b, path) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.ok && pb.ok) return isIdList(pa.value) && isIdList(pb.value) ? diffList(pa.value, pb.value, path) : diff(pa.value, pb.value, path);
  return textTimes(a) === textTimes(b) ? null : { path, a, b };
}

/** stderr: line by line; an `Error NNN: {json}` line compares its JSON as data. */
function diffErr(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length !== lb.length) return { path: 'stderr', a, b };
  for (let i = 0; i < la.length; i++) {
    const ma = la[i].match(/^(Error \d+: )(.*)$/);
    const mb = lb[i].match(/^(Error \d+: )(.*)$/);
    if (ma && mb && ma[1] === mb[1]) {
      const d = diffOut(ma[2], mb[2], `stderr[${i}]`);
      if (d) return d;
    } else if (textTimes(la[i]) !== textTimes(lb[i])) {
      return { path: `stderr[${i}]`, a: la[i], b: lb[i] };
    }
  }
  return null;
}

function compare(a, b) {
  if (a.code !== b.code) return { path: 'exit code', a: `${a.code} ${a.stderr}`, b: `${b.code} ${b.stderr}` };
  return diffOut(a.stdout, b.stdout, 'stdout') ?? diffErr(a.stderr, b.stderr);
}

const planJson = JSON.stringify({
  title: 'CLI plan',
  sddId: 'SDD-002',
  sprintId: 'SPRINT-001',
  context: { setupNotes: 'Notes', relevantFiles: ['a.js'], designDecisions: 'DD-001' },
  tasks: [{ title: 'First' }, { title: 'Second', blockedBy: ['Task 1'], steps: ['one', 'two'] }],
});

// --- the script ---
// Keys are written out: both sides must give the same ones. The fixture's highest keys are SB-005
// (archived), DC-001, DD-002, GAP-001, TERM-001, SDD-001, PLAN-002, TASK-004 and SPRINT-001.
// A step with `differs` is a change from 0.x that a DD lists; `check` says what must still hold.
const steps = [
  // reads
  { differs: 'DD-021: the version is the CLI\'s', argv: ['health'], check: (a, b) => a.code === 0 && b.code === 0 && diff({ ...parse(a.stdout).value, version: 0 }, { ...parse(b.stdout).value, version: 0 }) === null },
  ['get', 'SB-001'],
  ['get', 'SB-001', '--brief'],
  ['get', 'TERM-001'],
  ['get', 'DD-001'],
  ['get', 'SDD-001'],
  ['get', 'PLAN-001'],
  ['get', 'SPRINT-001'],
  ['get', 'SB-404'],
  ['get', 'TASK-001'],
  ['get', 'XYZ-001'],
  ['get'],
  ['list'],
  ['list', '--all'],
  ['list', '--limit', '2'],
  ['list', 'issue'],
  ['list', 'issues'],
  ['list', 'SB'],
  ['list', 'decision', '--json'],
  ['list', 'term'],
  ['list', '--stage', 'inbox'],
  ['list', '--priority', 'high'],
  ['list', '--frontier'],
  ['list', '--frontier', '--all-claims'],
  ['list', '--sprint', 'SPRINT-001'],
  ['list', 'plan'],
  ['list', 'plan', '--sprint', 'SPRINT-001'],
  ['list', 'sdd'],
  ['list', 'sprint'],
  ['list', 'bogus'],
  ['plans'],
  ['glossary'],
  ['glossary', '--json'],
  ['project'],
  ['project', 'SPRINT-001'],
  ['sprint', 'list'],
  ['plan', 'PLAN-001'],
  ['plan', 'list'],
  ['plan', 'nope'],
  ['next-task', 'PLAN-001'],
  ['next-task'],
  ['sdd', 'SDD-001'],
  ['sdd', 'list'],
  ['decision', 'DD-001'],
  ['concern', 'DC-001'],
  ['gap', 'list'],
  ['issue', 'list'],
  ['prompt', 'item', 'SB-001'],
  ['prompt', 'sdd', 'SDD-001'],
  ['prompt', 'plan', 'PLAN-001'],
  ['prompt', 'item', 'SB-404'],
  ['prompt', 'item'],
  ['patch', '--help'],
  // The help, and the commands that had no step (DD-028).
  ['help'],
  ['help', 'plan'],
  ['ready'],
  ['show', 'SB-001', '--brief'],
  ['init'],
  ['update', 'SB-001'],
  ['serve'],
  { argv: ['list'], cwd: 'sub/deeper' },
  // items
  ['create', 'issue', 'CLI issue', '--priority', 'high', '--body', 'Inline body', '--files', 'a.js,b.js', '--pillar', 'auth'],
  ['create', 'decision', 'CLI decision', '--sprint', 'SPRINT-001', '--body', '@body.md'],
  { argv: ['create', 'gap', 'From stdin', '--body', '-'], input: 'A body from stdin.\n' },
  ['create', 'term', 'Board', '--body', 'One repo\'s whole board.'],
  ['create', 'issue', 'Blocked one', '--blockedBy', 'SB-006'],
  ['create', 'sprint', 'Not this way'],
  ['create', 'issue'],
  ['create', 'bogus', 'Unknown type'],
  ['issue', 'Shorthand issue'],
  ['issue', 'list'],
  ['issue', 'get'],
  ['issue'],
  ['issue', 'SB-008', '--stage', 'exploring', '--priority', 'low'],
  ['concern', 'A concern'],
  // DD-030: a replace of a body with text names the body it replaces (--base), or says --force.
  { differs: 'DD-030: a replace of a filled body with no base exits 3', argv: ['decision', 'DD-003', '--body', 'Patched through the shorthand'], check: (a, b) => a.code === 0 && b.code === 3 && /--base/.test(b.stderr) },
  { differs: 'DD-030: --force replaces with no check', argv: ['decision', 'DD-003', '--body', 'Patched through the shorthand', '--force'], check: (a, b) => b.code === 0 && b.stdout === 'updated DD-003: body (29 chars)\n' },
  { differs: 'DD-030: pm get --brief prints bodyHash', argv: ['get', 'DD-003', '--brief'], check: (a, b) => parse(b.stdout).value?.bodyHash === hash('Patched through the shorthand') },
  { differs: 'DD-030: --prepend-body', argv: ['patch', 'DD-003', '--prepend-body', 'Superseded: read the block below.'], check: (a, b) => b.stdout === 'updated DD-003: body prepended (33 chars)\n' },
  { differs: 'DD-030: --append-body @file', argv: ['patch', 'DD-003', '--append-body', '@body.md'], check: (a, b) => b.stdout === 'updated DD-003: body appended (39 chars)\n' },
  { differs: 'DD-030: --append-body -', argv: ['patch', 'DD-003', '--append-body', '-'], input: 'From stdin.\n', check: (a, b) => b.stdout === 'updated DD-003: body appended (11 chars)\n' },
  { differs: 'DD-030: pm get prints bodyHash', argv: ['get', 'DD-003'], check: (a, b) => parse(b.stdout).value?.body === dd003Joined && parse(b.stdout).value?.bodyHash === hash(dd003Joined) },
  { differs: 'DD-030: a stale --base exits 3', argv: ['patch', 'DD-003', '--body', 'Stale copy', '--base', hash('Patched through the shorthand')], check: (a, b) => b.code === 3 && b.stderr.includes(`bodyHash ${hash(dd003Joined)}`) },
  { differs: 'DD-030: --body with --append-body is a usage error', argv: ['patch', 'DD-003', '--body', 'x', '--append-body', 'y'], check: (a, b) => b.code === 2 },
  { differs: 'DD-030: --base with the current hash replaces', argv: ['patch', 'DD-003', '--body', 'Patched through the shorthand', '--base', hash(dd003Joined)], check: (a, b) => b.code === 0 && b.stdout === 'updated DD-003: body (29 chars)\n' },
  ['patch', 'SB-006', '--stage', 'exploring', '--related', 'SB-001,SB-002', '--title', 'CLI issue, renamed'],
  ['patch', 'SB-006', '--blockedBy', ''],
  ['patch', 'SB-002', '--assignee', 'agent-c'],
  ['patch', 'TERM-002', '--aliases', 'boards'],
  ['patch', 'SB-404', '--title', 'x'],
  ['patch', 'SB-006', '--stage', 'nope'],
  ['patch'],
  ['get', 'SB-006'],
  ['get', 'DD-001'],
  ['glossary'],
  ['list', '--frontier'],
  // comments, claims
  ['comment', 'SB-001', 'A CLI comment'],
  ['comment', 'SB-001', 'Signed', '--author', 'agent-a'],
  ['comment', 'SDD-001', 'A design note'],
  ['comment', 'PLAN-001', 'A plan note'],
  ['comment', 'SPRINT-001', 'A project note'],
  ['comment', 'TASK-001', 'x'],
  ['comment', 'SB-001'],
  ['get', 'SB-001'],
  ['claim', 'SB-003', '--as', 'agent-a'],
  ['claim', 'SB-003', '--as', 'agent-b'],
  ['claim', 'SB-003', '--as', 'agent-a'],
  ['claim', 'SB-001'],
  ['claim', 'SB-404', '--as', 'agent-a'],
  ['list', '--frontier'],
  ['list', '--frontier', '--all-claims'],
  ['release', 'SB-003'],
  ['release'],
  // done, archive, sweep
  ['patch', 'SB-004', '--stage', 'done'],
  ['archive', 'SB-004', 'SB-404'],
  ['archive'],
  // 0.x's step here was sweep --days 30, which archived SB-003; sweep went in pm 1.1 (DD-028).
  ['archive', 'SB-003'],
  ['list', '--all'],
  // designs
  ['sdd', 'create', 'CLI design', '--items', 'SB-006,SB-404', '--sprint', 'SPRINT-001', '--body', 'Design body'],
  ['sdd', 'Shorthand design'],
  ['sdd', 'SDD-002', '--stage', 'planned'],
  ['sdd', 'create'],
  ['sdd', 'list'],
  ['sdd', 'create', 'list'],
  ['sdd', 'help'],
  ['sdd'],
  ['design', 'SDD-003'],
  // plans
  { argv: ['plan', 'create'], input: planJson },
  { argv: ['plan', 'create'], input: '{ not json' },
  { argv: ['plan', 'create'], input: '' },
  ['next-task', 'PLAN-003'],
  ['task-update', 'PLAN-003', 'TASK-005', '--status', 'in_progress', '--note', 'started'],
  ['task-update', 'PLAN-003', 'TASK-006', '--steps', '["a","b"]', '--verification', 'run it', '--description', '@body.md', '--passes', 'false'],
  ['task-update', 'PLAN-003', 'TASK-006', '--steps', 'not json'],
  ['task-update', 'PLAN-003'],
  ['task-done', 'PLAN-003', 'TASK-005', 'done in abc123'],
  ['task-done', 'PLAN-003', 'TASK-006', '@note.md'],
  { argv: ['task-done', 'PLAN-003', 'TASK-404', '-'], input: 'from stdin' },
  ['task-done', 'PLAN-003'],
  ['next-task', 'PLAN-003'],
  // These were plan-update until pm 1.1 (DD-028): patch changes a plan the same way.
  ['patch', 'PLAN-003', '--title', 'CLI plan, renamed', '--stage', 'in_progress'],
  ['patch', 'PLAN-002', '--tasks', '[{"title":"Only task"}]'],
  ['patch', 'PLAN-002', '--tasks', 'nope'],
  ['patch', 'PLAN-001', '--title', 'Renamed through patch'],
  ['get', 'PLAN-003'],
  ['get', 'PLAN-002'],
  ['list', 'plan'],
  // projects
  ['project', 'create', 'CLI project', '--destination', 'Somewhere', '--body', 'The project doc'],
  ['sprint', 'create', 'Second CLI project', '--problem-statement', 'Elsewhere'],
  ['project', 'create'],
  ['sprint', 'SPRINT-002', '--status', 'completed', '--destination', 'Somewhere else'],
  ['project', 'SPRINT-002'],
  ['project', 'SPRINT-002', '--json'],
  ['project'],
  ['project', 'SPRINT-404'],
  ['prompt', 'plan', 'PLAN-003'],
  ['frobnicate'],
  // the whole board at the end
  ['list', '--all', '--json'],
  ['list', 'sdd', '--json'],
  ['list', 'plan', '--json'],
  ['list', 'sprint', '--json'],
  // DD-016: 0.x sends --json in a PATCH, which 1.x would refuse; 1.x prints the project's JSON and changes nothing.
  { differs: 'DD-016: --json is not a patch field', argv: ['project', 'SPRINT-001', '--json'], check: (a, b) => a.code === 0 && b.code === 0 && parse(b.stdout).value?.id === 'SPRINT-001' && Array.isArray(parse(b.stdout).value?.items) },
  // DD-016: 0.x drops an unknown patch field without a word; 1.x refuses it.
  { differs: 'DD-016: an unknown field is refused', argv: ['patch', 'SB-001', '--prioritty', 'high'], check: (a, b) => a.code === 0 && b.code === 1 && /Unknown field/.test(b.stderr) },
];

let failures = 0;
let compared = 0;
const show = (v) => JSON.stringify(v)?.slice(0, 200);

// --- the expected mode: one file per step in tools/fixtures/cli-expected/ ---
const cliVersion = JSON.parse(readFileSync(here('../cli/package.json'), 'utf8')).version;
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
/** What changes from run to run, masked: the temp folder, the server, the slug, new times and comment ids. */
function mask(text) {
  let t = text;
  for (const [from, to] of [[realpathSync(v1Dir), '<repo>'], [v1Dir, '<repo>'], [v1Board.base, '<server>'], [slug, '<slug>']]) t = t.split(from).join(to);
  t = textTimes(t).replace(/\bc(\d{12,})\b/g, (m, ms) => (Number(ms) >= start - 1000 ? '<new comment id>' : m));
  // Node's own JSON.parse message changes with its version.
  t = t.replace(/^(Invalid JSON[^:\n]*: ).*$/gm, '$1<JSON.parse message>');
  // pm health prints the CLI's own version (DD-021); a release must not change the file.
  t = t.replace(new RegExp(`^(.* — pm )${cliVersion.replace(/\./g, '\\.')}$`, 'm'), '$1<cli version>');
  return t.split(`"version": "${cliVersion}"`).join('"version": "<cli version>"');
}
/** stdout as stored: JSON with sorted keys, text as it is. */
function storedOut(out) {
  const p = parse(out);
  return out.trim() && p.ok ? { kind: ' (JSON, keys sorted)', text: JSON.stringify(sortKeys(p.value), null, 2) + '\n' } : { kind: '', text: out };
}
/** stderr as stored: an `Error NNN: {json}` line keeps its JSON on one line, with sorted keys. */
const storedErr = (err) =>
  err
    .split('\n')
    .map((l) => {
      const m = l.match(/^(Error \d+: )(.*)$/);
      const p = m && parse(m[2]);
      return p?.ok ? m[1] + JSON.stringify(sortKeys(p.value)) : l;
    })
    .join('\n');
function render(step, r) {
  const out = storedOut(r.stdout);
  return mask(
    [
      `$ pm ${step.argv.map((x) => (/^[\w@.,:/=-]+$/.test(x) ? x : JSON.stringify(x))).join(' ')}`,
      ...(step.cwd ? [`(in ${step.cwd})`] : []),
      ...(step.input !== undefined ? [`(stdin ${JSON.stringify(step.input)})`] : []),
      `exit ${r.code}`,
      `--- stdout${out.kind}`,
      out.text + `--- stderr`,
      storedErr(r.stderr),
    ].join('\n'),
  );
}
/** One file per step, named after the command; a command that runs again gets .2, .3, ... */
const seen = new Map();
function fileName(step) {
  const base = [...step.argv, ...(step.cwd ? ['in', step.cwd] : [])].join('_').replace(/[^\w.,@-]+/g, '_').slice(0, 80) || 'no-args';
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return `${base}${n > 1 ? `.${n}` : ''}.txt`;
}

if (expectedMode) {
  console.log(`${slug}: 1.x cli/bin/pm on ${v1Board.base} against ${update ? 'new ' : ''}expected files in tools/fixtures/cli-expected`);
  mkdirSync(expectedDir, { recursive: true });
  const written = new Set();
  const actualDir = mkdtempSync(join(tmpdir(), 'pm-cli-actual-'));
  for (const s of steps) {
    const step = Array.isArray(s) ? { argv: s } : s;
    const name = fileName(step);
    const text = render(step, run(1, step.argv, step));
    const file = join(expectedDir, name);
    written.add(name);
    compared++;
    if (update) {
      writeFileSync(file, text);
      continue;
    }
    const want = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const same = want === text;
    console.log(`${same ? 'ok  ' : 'DIFF'}  pm ${step.argv.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}`);
    if (same) continue;
    failures++;
    if (want === null) {
      console.log(`      no file tools/fixtures/cli-expected/${name}: run with --update, then review the new file`);
      continue;
    }
    writeFileSync(join(actualDir, name), text);
    const d = spawnSync('diff', ['-u', '-L', `expected/${name}`, '-L', `actual/${name}`, file, join(actualDir, name)], { encoding: 'utf8' });
    console.log(d.stdout.replace(/^/gm, '      '));
  }
  rmSync(actualDir, { recursive: true, force: true });
  for (const f of readdirSync(expectedDir)) {
    if (written.has(f)) continue;
    if (update) rmSync(join(expectedDir, f));
    else {
      console.log(`DIFF  tools/fixtures/cli-expected/${f}: no step makes it; run with --update`);
      failures++;
    }
  }
  if (update) console.log(`wrote ${written.size} files; review them with git diff tools/fixtures/cli-expected`);
} else {
  console.log(`${slug}: 0.x ${v0Version} bin/pm against 1.x cli/bin/pm on ${v1Board.base}`);
  for (const s of steps) {
    const step = Array.isArray(s) ? { argv: s } : s;
    const a = run(0, step.argv, step);
    const b = run(1, step.argv, step);
    const label = `pm ${step.argv.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}`;
    if (step.differs) {
      const ok = step.check(a, b);
      console.log(`${ok ? 'ok  ' : 'DIFF'}  ${label}: ${step.differs}`);
      if (!ok) {
        console.log(`      0.x ${a.code} ${show(a.stdout + a.stderr)}\n      1.x ${b.code} ${show(b.stdout + b.stderr)}`);
        failures++;
      }
      continue;
    }
    compared++;
    const d = compare(a, b);
    console.log(`${d ? 'DIFF' : 'same'}  ${label} -> ${a.code}`);
    if (d) {
      console.log(`      ${d.path}: 0.x ${show(d.a)}\n      ${' '.repeat(d.path.length)}  1.x ${show(d.b)}`);
      failures++;
    }
  }
}

// --- 1.x only: the commands that have no 0.x answer to compare with (DD-021) ---
function v1In(cwd, argv, env = {}, input = '') {
  const r = spawnSync(process.execPath, [v1Bin, ...argv], { cwd, env: { ...v1Env, ...env }, input, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const newSlug = `${slug}-init`;
const repoA = join(v1Dir, 'repo-a');
const repoB = join(v1Dir, 'repo-b');
mkdirSync(join(repoA, 'nested'), { recursive: true });
mkdirSync(repoB, { recursive: true });
const pmJson = (dir) => parse(readFileSync(join(dir, '.pm.json'), 'utf8')).value;
const only = [
  ['init with no slug is a usage error', () => v1In(repoA, ['init']), (r) => r.code === 2 && /Usage: pm init <slug>/.test(r.stderr)],
  ['init with no token is 401 and writes no .pm.json', () => v1In(repoA, ['init', newSlug], { PM_TOKEN: '' }), (r) => r.code === 1 && /Error 401/.test(r.stderr) && /PM_TOKEN/.test(r.stderr)],
  ['init creates the board and writes .pm.json', () => v1In(repoA, ['init', newSlug, '--name', 'Init board']), (r) => r.code === 0 && /Created board "Init board"/.test(r.stdout) && pmJson(repoA)?.board === newSlug],
  ['init again in the same folder is refused', () => v1In(repoA, ['init', newSlug]), (r) => r.code === 1 && /already exists/.test(r.stderr)],
  ['init of a board that exists links to it', () => v1In(repoB, ['init', newSlug]), (r) => r.code === 0 && /linked/.test(r.stdout) && pmJson(repoB)?.board === newSlug],
  ['a bad slug is 400', () => v1In(join(repoA, 'nested'), ['init', 'Not A Slug']), (r) => r.code === 1 && /Error 400/.test(r.stderr)],
  ['a new board lists nothing, from a subfolder', () => v1In(join(repoA, 'nested'), ['list']), (r) => r.code === 0 && r.stdout === '(none)\n'],
  ['its first issue is SB-001, from the other clone', () => v1In(repoB, ['create', 'issue', 'First']), (r) => r.code === 0 && r.stdout === 'created SB-001 (issue): First\n'],
  ['the first clone sees it', () => v1In(repoA, ['list']), (r) => r.code === 0 && /^SB-001 {2}First$/m.test(r.stdout)],
  ['health names the board', () => v1In(repoA, ['health']), (r) => r.code === 0 && parse(r.stdout).value?.project === 'Init board'],
  ['--board picks another board', () => v1In(repoA, ['get', 'SB-001', '--board', slug]), (r) => r.code === 0 && parse(r.stdout).value?.title === 'Fix the login flow'],
  ['a write with no token is 401 with a hint', () => v1In(repoA, ['create', 'issue', 'x'], { PM_TOKEN: '' }), (r) => r.code === 1 && /^Error 401: /.test(r.stderr) && /PM_TOKEN/.test(r.stderr)],
  ['a write with a wrong token is 401', () => v1In(repoA, ['comment', 'SB-001', 'x'], { PM_TOKEN: 'wrong' }), (r) => r.code === 1 && /^Error 401: /.test(r.stderr)],
  ['a read needs no token', () => v1In(repoA, ['get', 'SB-001'], { PM_TOKEN: '' }), (r) => r.code === 0],
  ['the token and url come from ~/.config/pm/config.json', () => {
    const cfgHome = join(v1Dir, 'cfg-home');
    mkdirSync(join(cfgHome, 'pm'), { recursive: true });
    writeFileSync(join(cfgHome, 'pm', 'config.json'), JSON.stringify({ url: v1Board.base, token: v1Board.token }));
    return v1In(repoA, ['comment', 'SB-001', 'From the config file'], { PM_URL: '', PM_TOKEN: '', XDG_CONFIG_HOME: cfgHome });
  }, (r) => r.code === 0 && r.stdout === 'commented on SB-001 as claude\n'],
  ['no .pm.json is an error that names pm init', () => v1In(tmpdir(), ['list']), (r) => r.code === 1 && /pm init <slug>/.test(r.stderr)],
  ['serve, start and stop print a note', () => v1In(repoA, ['serve']), (r) => r.code === 0 && /gone in pm 1.x/.test(r.stdout)],
  // Removed in pm 1.1 (DD-028): exit 2, nothing on stdout, and the command to use instead. With
  // arguments and with --help too, and with no board: the answer needs none.
  ...[
    [['sweep', '--days', '30'], /Use: pm list --stage done, then pm archive/],
    [['explore', 'SPRINT-001'], /Use: pm project SPRINT-NNN/],
    [['suggest', 'SPRINT-001'], /Use: pm list, then pm patch <id> --sprint/],
    [['review', 'sdd', 'SDD-001'], /Use: pm get <id>/],
    [['plan-update', 'PLAN-001', '--stage', 'done'], /Use: pm patch PLAN-NNN/],
    [['sdds'], /Use: pm list sdd$/m],
    [['designs', '--help'], /Use: pm list sdd$/m],
    [['sprints'], /Use: pm project list$/m],
    [['help', 'sweep'], /Use: pm list --stage done/],
  ].map(([argv, use]) => [`pm ${argv.join(' ')} names its replacement and exits 2`, () => v1In(tmpdir(), argv),
    (r) => r.code === 2 && r.stdout === '' && /^pm [a-z-]+ was removed in pm 1\.1 \(DD-028\)\.$/m.test(r.stderr) && use.test(r.stderr)]),
  ['the hidden aliases still work', () => {
    const rs = [['sprint', 'SPRINT-001'], ['design', 'SDD-001'], ['plans'], ['issue', 'SB-001'], ['decision', 'DD-001']].map((a) => v1In(repoB, [...a, '--board', slug]));
    return { code: rs.reduce((n, r) => n + r.code, 0), stdout: rs.map((r) => r.stdout.slice(0, 40)).join('|'), stderr: rs.map((r) => r.stderr).join('') };
  }, (r) => r.code === 0],
  ['a hidden alias is not suggested', () => v1In(repoA, ['sprnt']), (r) => r.code === 2 && !/pm sprint/.test(r.stderr)],
  // The command table (PLAN-003 Task 3, DD-025): help per command, --version, did-you-mean, flag checks.
  ['--version prints the version', () => v1In(repoA, ['--version']), (r) => r.code === 0 && /^pm \d+\.\d+\.\d+/.test(r.stdout)],
  ['pm help lists the commands by group', () => v1In(repoA, ['help']), (r) => r.code === 0 && /^Read:$/m.test(r.stdout) && /^  ready /m.test(r.stdout) && !/^  (sdds|issue|sdd|prompt) /m.test(r.stdout)],
  ['every command has its own help, the hidden ones too', () => {
    const names = ['get', 'list', 'ready', 'glossary', 'create', 'patch', 'comment', 'claim', 'release', 'archive', 'plan', 'next-task', 'task-update', 'task-done', 'project', 'init', 'update', 'health', 'issue', 'decision', 'concern', 'gap', 'sdd', 'prompt', 'plans'];
    const bad = names.filter((n) => { const r = v1In(repoA, ['help', n]); return r.code !== 0 || !r.stdout.startsWith(`Usage: pm ${n}`); });
    return { code: bad.length, stdout: bad.join(','), stderr: '' };
  }, (r) => r.code === 0],
  ['pm <command> --help is that command\'s help', () => v1In(repoA, ['create', '--help']), (r) => r.code === 0 && r.stdout.startsWith('Usage: pm create') && /--priority P/.test(r.stdout)],
  ['show is get', () => v1In(repoA, ['show', 'SB-001', '--brief']), (r) => r.code === 0 && parse(r.stdout).value?.id === 'SB-001'],
  ['ready is list --frontier', () => v1In(repoA, ['ready']), (r) => r.code === 0 && r.stdout === v1In(repoA, ['list', '--frontier']).stdout],
  ['a typo command gets did-you-mean and exit 2', () => v1In(repoA, ['lsit']), (r) => r.code === 2 && /Did you mean: pm list\?/.test(r.stderr) && r.stdout === ''],
  ['a guessed command names the right one', () => v1In(repoA, ['view', 'SB-001']), (r) => r.code === 2 && /Did you mean: pm get\?/.test(r.stderr)],
  ['an unknown flag is refused with a suggestion', () => v1In(repoA, ['list', '--status', 'done']), (r) => r.code === 2 && /Unknown flag --status for pm list\. Did you mean --stage\?/.test(r.stderr)],
  ['patch passes any field to the server', () => v1In(repoA, ['patch', 'SB-001', '--prioritty', 'high']), (r) => r.code === 1 && /Unknown field/.test(r.stderr)],
  ['update with arguments never runs npm', () => v1In(repoA, ['update', 'SB-001', '--stage', 'done']), (r) => r.code === 2 && /takes no arguments/.test(r.stderr) && !/Updating/.test(r.stdout)],
  ['a usage error exits 2', () => v1In(repoA, ['get']), (r) => r.code === 2 && /Usage: pm get <id>/.test(r.stderr)],
  ['an API error still exits 1', () => v1In(repoA, ['get', 'SB-999']), (r) => r.code === 1 && /^Error 404/.test(r.stderr)],
  // Plans (PLAN-003 Task 4, DD-026).
  ['pm plan --json is the whole plan, as pm get', () => {
    const a = v1In(repoB, ['plan', 'PLAN-001', '--json', '--board', slug]);
    const b = v1In(repoB, ['get', 'PLAN-001', '--board', slug]);
    return { code: a.code || b.code, stdout: String(diff(parse(a.stdout).value, parse(b.stdout).value) === null), stderr: '' };
  }, (r) => r.code === 0 && r.stdout === 'true'],
  ['pm plan shows one line per task and the next task', () => v1In(repoB, ['plan', 'PLAN-003', '--board', slug]), (r) => r.code === 0 && /^Tasks:$/m.test(r.stdout) && /^Next: |^Every task passed\.|^No task can start/m.test(r.stdout) && !/"steps"/.test(r.stdout)],
  ['pm get TASK-NNN reads one task with its plan', () => v1In(repoB, ['get', 'TASK-001', '--board', slug]), (r) => r.code === 0 && parse(r.stdout).value?.id === 'TASK-001' && parse(r.stdout).value?.planId === 'PLAN-001'],
  ['pm next-task puts the next task in full under next', () => v1In(repoB, ['next-task', 'PLAN-001', '--board', slug]), (r) => {
    const j = parse(r.stdout).value;
    return r.code === 0 && j?.planId === 'PLAN-001' && Array.isArray(j.tasks) && (j.next === null || typeof j.next.id === 'string') && j.tasks.every((t) => !('steps' in t));
  }],
  ['pm next-task --json is the answer as before 1.1', () => v1In(repoB, ['next-task', 'PLAN-001', '--json', '--board', slug]), (r) => r.code === 0 && Array.isArray(parse(r.stdout).value?.tasks) && 'unblocked' in (parse(r.stdout).value?.tasks?.[0] ?? {})],
  // Write receipts (PLAN-003 Task 5, DD-027).
  ['a write prints one line, and --json the server\'s answer', () => {
    const a = v1In(repoB, ['create', 'issue', 'Receipt check']);
    const b = v1In(repoB, ['create', 'issue', 'Receipt check, JSON', '--json']);
    return { code: a.code || b.code, stdout: a.stdout + '|' + (parse(b.stdout).value?.title ?? ''), stderr: '' };
  }, (r) => r.code === 0 && r.stdout === 'created SB-002 (issue): Receipt check\n|Receipt check, JSON'],
  ['a claim says until when', () => v1In(repoB, ['claim', 'SB-002', '--as', 'agent-z']), (r) => r.code === 0 && /^claimed SB-002 for agent-z until \d{4}-\d\d-\d\dT/.test(r.stdout)],
  ['a patch names each field as the server has it', () => v1In(repoB, ['patch', 'SB-002', '--stage', 'exploring', '--related', 'SB-001', '--body', 'twelve chars']), (r) => r.code === 0 && r.stdout === 'updated SB-002: stage exploring, related SB-001, body (12 chars)\n'],
  // A body write never loses text (PLAN-004, DD-030).
  ['the bodyHash pm get prints is the one the server checks', () => {
    const got = parse(v1In(repoB, ['get', 'SB-002']).stdout).value;
    const refused = v1In(repoB, ['patch', 'SB-002', '--body', 'No base']);
    return { code: refused.code, stdout: String(got?.bodyHash === hash(got?.body ?? '') && refused.stderr.includes(`bodyHash ${got?.bodyHash}`)), stderr: refused.stderr };
  }, (r) => r.code === 3 && r.stdout === 'true' && /--force/.test(r.stderr) && /pm update/.test(r.stderr)],
  ['two agents read one body: the first replace wins, the stale one exits 3, and no line is lost', () => {
    const base = parse(v1In(repoB, ['get', 'SB-002']).stdout).value?.bodyHash;
    const other = v1In(repoB, ['patch', 'SB-002', '--append-body', '-'], {}, 'A line from the second agent.');
    const stale = v1In(repoB, ['patch', 'SB-002', '--body', 'Built from the stale read', '--base', base]);
    const body = parse(v1In(repoB, ['get', 'SB-002']).stdout).value?.body ?? '';
    return { code: stale.code, stdout: other.stdout + String(body.endsWith('\n\nA line from the second agent.')), stderr: stale.stderr };
  }, (r) => r.code === 3 && r.stdout === 'updated SB-002: body appended (29 chars)\ntrue' && /changed since you read it/.test(r.stderr)],
  ['pm sdd <id> and pm project <id> take the body flags', () => {
    const a = v1In(repoB, ['sdd', 'SDD-001', '--append-body', 'Design addendum', '--board', slug]);
    const b = v1In(repoB, ['project', 'SPRINT-001', '--prepend-body', 'Project note', '--board', slug]);
    const doc = parse(v1In(repoB, ['get', 'SPRINT-001', '--board', slug]).stdout).value;
    const c = v1In(repoB, ['project', 'SPRINT-001', '--body', 'Replaced', '--base', doc?.bodyHash, '--board', slug]);
    return { code: a.code || b.code || c.code, stdout: a.stdout + b.stdout + c.stdout, stderr: a.stderr + b.stderr + c.stderr };
  }, (r) => r.code === 0 && r.stdout === 'updated SDD-001: body appended (15 chars)\nupdated SPRINT-001: body prepended (12 chars)\nupdated SPRINT-001: body (8 chars)\n'],
  // The server sorts, cuts and finds terms (PLAN-003 Task 6, DD-029).
  ['pm list --limit 2 prints the newest 2 rows of pm list --json, and counts the rest', () => {
    const all = parse(v1In(repoB, ['list', '--json', '--board', slug]).stdout).value ?? [];
    const key = (it) => it.updatedAt || it.createdAt || '';
    const newest = [...all].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).slice(-2);
    const width = Math.max(...newest.map((it) => it.id.length));
    const want = `… ${all.length - 2} older hidden (use --all or --limit N)\n` + newest.map((it) => `${it.id.padEnd(width)}  ${it.title}\n`).join('');
    const r = v1In(repoB, ['list', '--limit', '2', '--board', slug]);
    return { ...r, stdout: String(all.length > 2 && r.stdout === want) };
  }, (r) => r.code === 0 && r.stdout === 'true'],
  ['pm glossary <word> prints one term, by an alias in any case', () => v1In(repoB, ['glossary', 'SESSIONS', '--board', slug]), (r) => r.code === 0 && r.stdout === 'TERM-001  Session\nAliases: sessions\nThe time a user stays logged in.\n'],
  ['pm glossary <id> prints that term', () => v1In(repoB, ['glossary', 'term-002', '--board', slug]), (r) => r.code === 0 && r.stdout === 'TERM-002  Board\nAliases: boards\nOne repo\'s whole board.\n'],
  ['pm glossary <signpost> says what to use instead, and pm get footnotes it', () => {
    const made = v1In(repoB, ['create', 'term', 'login time', '--board', slug]);
    const id = made.stdout.match(/^created (TERM-\d+)/)?.[1];
    v1In(repoB, ['patch', id, '--related', 'TERM-001', '--board', slug]);
    const a = v1In(repoB, ['glossary', 'Login  Time', '--board', slug]);
    const b = v1In(repoB, ['get', id, '--board', slug]);
    return { code: a.code || b.code, stdout: a.stdout.replace(id, '<id>') + b.stderr.replace(id, '<id>'), stderr: '' };
  }, (r) => r.code === 0 && r.stdout === '<id>  login time\n⚠ use Session instead (TERM-001)\n\nGlossary: <id> login time (use Session instead)\n'],
  ['pm glossary <miss> names the closest term and exits 1', () => v1In(repoB, ['glossary', 'sesion', '--board', slug]), (r) => r.code === 1 && r.stdout === '' && r.stderr === 'No term "sesion". Did you mean: Session (TERM-001)?\nEvery term: pm glossary\n'],
  ['pm glossary <word> --json is the term\'s record', () => v1In(repoB, ['glossary', 'board', '--json', '--board', slug]), (r) => r.code === 0 && parse(r.stdout).value?.id === 'TERM-002' && parse(r.stdout).value?.body === 'One repo\'s whole board.'],
  ['a server that does not answer names its url', () => v1In(repoA, ['list'], { PM_URL: 'http://127.0.0.1:9' }), (r) => r.code === 1 && /Cannot reach the pm server at http:\/\/127.0.0.1:9/.test(r.stderr)],
];
for (const [name, act, ok] of only) {
  const r = act();
  const good = ok(r);
  console.log(`${good ? 'ok  ' : 'FAIL'}  1.x: ${name}`);
  if (!good) {
    console.log(`      ${r.code} ${show(r.stdout)} ${show(r.stderr)}`);
    failures++;
  }
}

v1Board.close();
if (v0Dir) rmSync(v0Dir, { recursive: true, force: true });
rmSync(v1Dir, { recursive: true, force: true });
console.log(failures ? `${failures} differences` : `no differences (${compared} commands, ${only.length} 1.x-only checks)`);
process.exit(failures ? 1 : 0);
