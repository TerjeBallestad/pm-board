// pm's own argument rules (DD-023): every library tried broke at least one of these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/args.js';

test('the first word is the command, the rest are positionals and flags', () => {
  assert.deepEqual(parseArgs(['get', 'SB-1', '--brief']), { subcmd: 'get', positional: ['SB-1'], flags: { brief: 'true' } });
});

test('values stay strings', () => {
  assert.deepEqual(parseArgs(['patch', 'SB-1', '--title', '123']).flags, { title: '123' });
});

test("--blockedBy '' is the empty string, which clears the list", () => {
  assert.equal(parseArgs(['patch', 'SB-1', '--blockedBy', '']).flags.blockedBy, '');
});

test('an unknown flag keeps its value, for the server to check (DD-016)', () => {
  assert.deepEqual(parseArgs(['patch', 'SB-1', '--foo', 'bar']), { subcmd: 'patch', positional: ['SB-1'], flags: { foo: 'bar' } });
});

test('all, help, json and all-claims never take a value', () => {
  assert.deepEqual(parseArgs(['list', '--all', 'issue']), { subcmd: 'list', positional: ['issue'], flags: { all: 'true' } });
});

test('--server takes a value only when it looks like a URL or a host', () => {
  assert.equal(parseArgs(['get', '--server', 'https://pm.example.com', 'SB-2']).flags.server, 'https://pm.example.com');
  assert.equal(parseArgs(['get', '--server', 'localhost:5055']).flags.server, 'http://localhost:5055');
  assert.deepEqual(parseArgs(['get', '--server', 'SB-2']), { subcmd: 'get', positional: ['SB-2'], flags: { server: 'true' } });
});

test('a flag before another flag is "true"', () => {
  assert.deepEqual(parseArgs(['list', '--frontier', '--limit', '5']).flags, { frontier: 'true', limit: '5' });
});
