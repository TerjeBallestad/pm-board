// "Did you mean" (DD-025). help.js imports runtime.js, which reads process.argv; the import is
// fine here because only distance and closest run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, closest, GUESSES, FLAG_GUESSES } from '../lib/help.js';

const names = ['get', 'show', 'list', 'ready', 'create', 'patch', 'comment', 'claim', 'release', 'archive', 'plan', 'next-task', 'task-done', 'task-update', 'plan-update', 'project', 'glossary', 'sweep', 'init', 'update', 'health'];

test('a swap of two letters is one edit', () => {
  assert.equal(distance('lsit', 'list'), 1);
});

test('typos find the command', () => {
  for (const [typo, want] of [['lsit', 'list'], ['gt', 'get'], ['creat', 'create'], ['claimm', 'claim'], ['glosary', 'glossary'], ['plna', 'plan'], ['next', 'next-task']]) {
    assert.equal(closest(typo, names), want, typo);
  }
});

test('nothing close gives nothing, and an ambiguous prefix gives nothing', () => {
  assert.equal(closest('xyz', names), null);
  assert.equal(closest('task', names), null);
});

test('every guess names a real command or flag', () => {
  for (const want of Object.values(GUESSES)) assert.ok(names.includes(want) || ['--version', 'release', 'comment'].includes(want), want);
  assert.equal(FLAG_GUESSES.status, 'stage');
});
