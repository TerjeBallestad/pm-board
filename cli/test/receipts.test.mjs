// Write receipts (DD-027): one line with the key and what the server made of each field sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, claimEnd, archived } from '../lib/output.js';
import { state } from '../lib/runtime.js';

test('each field sent, as the answer has it, with the request names mapped', () => {
  const sent = { stage: 'done', related: 'SB-1, SB-2', sprint: 'SPRINT-001', body: 'x'.repeat(30) };
  const answer = { stage: 'done', related: ['SB-1', 'SB-2'], sprintId: 'SPRINT-001', body: 'x'.repeat(30) };
  assert.equal(changes(sent, answer), 'stage done, related SB-1,SB-2, sprintId SPRINT-001, body (30 chars)');
});

test('a cleared field reads as empty, a value with a comma is quoted, a task list is counted', () => {
  assert.equal(changes({ blockedBy: '' }, { blockedBy: [] }), "blockedBy ''");
  assert.equal(changes({ title: 'a, b' }, { title: 'a, b' }), 'title "a, b"');
  assert.equal(changes({ tasks: [{}, {}] }, { tasks: [{ id: 'T-1' }, { id: 'T-2' }] }), 'tasks (2)');
});

test('a claim ends after the board\'s claimTtlHours, or never', () => {
  state.config = { claimTtlHours: 4 };
  assert.equal(claimEnd({ assignedAt: '2026-01-01T10:00:00.000Z' }), 'until 2026-01-01T14:00:00.000Z');
  state.config = { claimTtlHours: 0 };
  assert.equal(claimEnd({ assignedAt: '2026-01-01T10:00:00.000Z' }), 'with no expiry');
  state.config = null;
});

test('archive names the ids, or says why nothing moved', () => {
  assert.equal(archived({ archived: 2, ids: ['SB-1', 'SB-2'] }, 'none'), 'archived 2: SB-1, SB-2');
  assert.equal(archived({ archived: 0, ids: [] }, 'none'), 'none');
});
