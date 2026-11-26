// pm itself against a stub server: every read of one record prints bodyHash (DD-030), and the body
// flags are checked for presence, not truth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PM = fileURLToPath(new URL('../bin/pm', import.meta.url));
const BODY = 'First line.\n';
const HASH = 'a3a433f4d36f';
const records = {
  '/api/boards/t/config': { stages: ['inbox', 'done'] },
  '/api/boards/t/items/SB-001': { id: 'SB-001', type: 'issue', title: 'A', body: BODY },
  '/api/boards/t/items/DD-001': { id: 'DD-001', type: 'decision', title: 'B', body: BODY },
  '/api/boards/t/designs/SDD-001': { id: 'SDD-001', title: 'C', body: BODY },
  '/api/boards/t/sprints/SPRINT-001': { id: 'SPRINT-001', name: 'P', status: 'active', body: BODY, items: [], designs: [], plans: [] },
};
const requests = [];
let server, url;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const record = req.method === 'GET' ? records[req.url] : undefined;
    res.writeHead(record ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(record ?? { error: 'not found' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function pm(...args) {
  const env = { ...process.env, PM_URL: url, PM_TOKEN: 'test', XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pm-test-')) };
  return new Promise(resolve => {
    execFile(process.execPath, [PM, ...args, '--board', 't'], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

for (const args of [['issue', 'SB-001'], ['decision', 'DD-001'], ['sdd', 'SDD-001'], ['project', 'SPRINT-001', '--json']]) {
  test(`pm ${args.join(' ')} prints bodyHash, as pm get does`, async () => {
    const { code, stdout } = await pm(...args);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).bodyHash, HASH);
  });
}

test('pm project <id> names the doc\'s bodyHash, for --base', async () => {
  const { code, stdout } = await pm('project', 'SPRINT-001');
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`Project doc: ${BODY.length} chars, bodyHash ${HASH}`));
});

test('--body \'\' with --append-body is a usage error, exit 2, and sends nothing', async () => {
  requests.length = 0;
  for (const block of ['--append-body', '--prepend-body']) {
    const { code, stderr } = await pm('patch', 'SB-001', '--body', '', block, 'y');
    assert.equal(code, 2, stderr);
    assert.match(stderr, /Use one or the other/);
  }
  assert.deepEqual(requests.filter(r => !r.startsWith('GET')), []);
});

test('a block that starts with -- is read as a flag: the error says to put it in a file', async () => {
  const { code, stderr } = await pm('patch', 'SB-001', '--prepend-body', '--- Superseded');
  assert.equal(code, 2);
  assert.match(stderr, /--prepend-body needs a value\. A value that starts with -- goes in a file: --prepend-body @block\.md/);
});
