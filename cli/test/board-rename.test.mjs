// pm against a stub server: a board renamed with pm board-rename, and the one hint line on stderr
// when the server answers that the slug pm sent is an old slug (DD-035). stdout does not change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PM = fileURLToPath(new URL('../bin/pm', import.meta.url));
// pm in these tests names the board with --board, so the hint says to change that.
const HINT = 'pm: board time-turtle is now makron. Use --board makron.\n';
const item = { id: 'SB-001', type: 'issue', title: 'A', stage: 'inbox' };
const requests = [];
let server, url;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      const m = req.url.match(/^\/api\/boards\/([^/]+)(\/.*)?$/);
      const slug = m?.[1];
      // time-turtle is an old slug of makron: the server answers as for makron, with the header.
      const headers = { 'Content-Type': 'application/json', ...(slug === 'time-turtle' ? { 'X-Pm-Board': 'makron' } : {}) };
      const rest = m?.[2] || '';
      let status = 404, answer = { error: 'Not found' };
      if (req.method === 'GET' && rest === '/config') [status, answer] = [200, { name: 'Makron', stages: ['inbox', 'done'], entityTypes: { SB: { label: 'Issue' } } }];
      if (req.method === 'GET' && rest === '/items/SB-001') [status, answer] = [200, item];
      if (req.method === 'GET' && rest.startsWith('/items?')) [status, answer] = [200, []];
      if (req.method === 'PATCH' && rest === '') {
        const body = JSON.parse(raw);
        [status, answer] = [200, { slug: body.slug || slug, name: body.name || 'Time Turtle', aliases: body.slug ? [slug] : [] }];
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function run(args, cwd) {
  const env = { ...process.env, PM_URL: url, PM_TOKEN: 'test', XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pm-test-')) };
  return new Promise(resolve => {
    execFile(process.execPath, [PM, ...args], { env, cwd }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const pm = (board, ...args) => run([...args, '--board', board]);

/** pm in a folder whose .pm.json names <board>. */
function pmIn(board, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-repo-'));
  writeFileSync(join(dir, '.pm.json'), JSON.stringify({ board }));
  return run(args, dir);
}

test('a read through an old slug prints the same stdout, and one hint line on stderr', async () => {
  const viaOld = await pm('time-turtle', 'get', 'SB-001');
  const viaNew = await pm('makron', 'get', 'SB-001');
  assert.equal(viaOld.code, 0, viaOld.stderr);
  assert.equal(viaOld.stdout, viaNew.stdout);
  assert.deepEqual(JSON.parse(viaOld.stdout), item);
  // Two requests (config, then the item) carry the header; the hint is printed once.
  assert.equal(viaOld.stderr.split('\n').filter(l => l.startsWith('pm: board')).join('\n') + '\n', HINT);
  assert.doesNotMatch(viaNew.stderr, /is now/);
});

test('with .pm.json naming the old slug, the hint says to update .pm.json', async () => {
  const { code, stderr } = await pmIn('time-turtle', 'get', 'SB-001');
  assert.equal(code, 0, stderr);
  assert.match(stderr, /^pm: board time-turtle is now makron\. Update \.pm\.json to \{"board": "makron"\}\.\n/);
});

test('pm board-rename through an old slug prints one hint, with the slug after the rename', async () => {
  const { code, stdout, stderr } = await pmIn('time-turtle', 'board-rename', 'mk');
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'updated board time-turtle: slug mk\n');
  assert.equal(stderr, 'pm: board time-turtle is now mk. Update .pm.json to {"board": "mk"}.\n');
});

test('pm board-rename sends slug and name to the board, prints one line, and the hint', async () => {
  requests.length = 0;
  const { code, stdout, stderr } = await pm('tt', 'board-rename', 'makron', '--name', 'Makron');
  assert.equal(code, 0, stderr);
  const patch = requests.find(r => r.method === 'PATCH');
  assert.equal(patch.url, '/api/boards/tt');
  assert.deepEqual(patch.body, { slug: 'makron', name: 'Makron' });
  assert.equal(stdout, 'updated board tt: slug makron, name Makron\n');
  assert.equal(stderr, HINT.replace('time-turtle', 'tt'));
});

test('pm board-rename --name alone keeps the slug: no hint', async () => {
  const { code, stdout, stderr } = await pm('makron', 'board-rename', '--name', 'Makron');
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'updated board makron: name Makron\n');
  assert.equal(stderr, '');
});

test('pm board-rename --json prints the server\'s answer', async () => {
  const { stdout } = await pm('makron', 'board-rename', 'mk', '--json');
  assert.deepEqual(JSON.parse(stdout), { slug: 'mk', name: 'Time Turtle', aliases: ['makron'] });
});

test('pm board-rename with nothing to change is a usage error, exit 2, and sends nothing', async () => {
  requests.length = 0;
  for (const args of [[], ['a', 'b'], ['--name']]) {
    const { code, stderr } = await pm('makron', 'board-rename', ...args);
    assert.equal(code, 2, `${args}: ${stderr}`);
  }
  assert.deepEqual(requests.filter(r => r.method !== 'GET'), []);
});
