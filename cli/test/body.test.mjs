// The body guard on the CLI side (DD-030): the hash pm get prints, the flags pm patch sends, and
// the line a body write prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyHash, withBodyHash, bodyField } from '../lib/records.js';
import { changes } from '../lib/output.js';

test('bodyHash is the first 12 hex characters of the sha256 of the body as UTF-8, as the server hashes it', () => {
  // The same vectors as the server's BodyGuardTests.
  assert.equal(bodyHash(''), 'e3b0c44298fc');
  assert.equal(bodyHash('Blåbær ✓'), '652e8ec72474');
});

test('pm get puts bodyHash next to a body, and adds none to a record with no body', () => {
  const out = withBodyHash({ id: 'SB-1', body: 'Blåbær ✓', comments: [] });
  assert.deepEqual(Object.keys(out), ['id', 'body', 'bodyHash', 'comments']);
  assert.equal(out.bodyHash, '652e8ec72474');
  assert.deepEqual(withBodyHash({ id: 'SB-2' }), { id: 'SB-2' });
  assert.deepEqual(withBodyHash({ id: 'SPRINT-1', body: '' }), { id: 'SPRINT-1', body: '' });
});

test('the body flags are the server fields of DD-030', () => {
  assert.deepEqual(bodyField('base', 'abc123def456'), ['bodyBase', 'abc123def456']);
  assert.deepEqual(bodyField('force', 'true'), ['force', true]);
  assert.deepEqual(bodyField('prepend-body', 'Top'), ['bodyPrepend', 'Top']);
  assert.deepEqual(bodyField('append-body', 'End'), ['bodyAppend', 'End']);
  assert.equal(bodyField('stage', 'done'), null);
});

test('a block added prints its size; the base and force print nothing', () => {
  assert.equal(changes({ bodyPrepend: 'x'.repeat(240) }, { body: 'longer' }), 'body prepended (240 chars)');
  assert.equal(changes({ bodyAppend: 'abc' }, { body: 'longer' }), 'body appended (3 chars)');
  assert.equal(changes({ body: 'x'.repeat(12), bodyBase: 'e3b0c44298fc' }, { body: 'x'.repeat(12) }), 'body (12 chars)');
  assert.equal(changes({ body: 'abcd', force: true }, { body: 'abcd' }), 'body (4 chars)');
});
