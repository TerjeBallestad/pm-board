// The next task (DD-026): the first in plan order that has not passed and whose blockers passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOf, nextTaskSummary } from '../lib/output.js';

const t = (id, extra) => ({ id, title: id, status: 'pending', passes: false, unblocked: true, ...extra });

test('a passed task is never next', () => {
  assert.equal(nextOf({ tasks: [t('TASK-1', { passes: true, status: 'done' }), t('TASK-2')] }).id, 'TASK-2');
});

test('a blocked task is skipped, even when it comes first', () => {
  const tasks = [t('TASK-1', { unblocked: false, blockedBy: ['TASK-2'] }), t('TASK-2')];
  assert.equal(nextOf({ tasks }).id, 'TASK-2');
});

test('no next task when every task passed or waits', () => {
  assert.equal(nextOf({ tasks: [t('TASK-1', { passes: true })] }), null);
  assert.equal(nextOf({ tasks: [t('TASK-1', { unblocked: false })] }), null);
  assert.equal(nextOf({}), null);
});

test('the summary keeps the next task whole and the others short, with the last note of a finished one', () => {
  const tasks = [
    t('TASK-1', { passes: true, status: 'done', steps: ['a'], progressNotes: [{ text: 'old' }, { text: 'merged in abc' }] }),
    t('TASK-2', { steps: ['b', 'c'], description: 'do it' }),
  ];
  const s = nextTaskSummary('PLAN-1', { planTitle: 'P', tasks, progress: { completed: 1, total: 2 }, allComplete: false });
  assert.equal(s.next.id, 'TASK-2');
  assert.deepEqual(s.next.steps, ['b', 'c']);
  assert.equal(s.tasks[0].lastNote, 'merged in abc');
  assert.ok(s.tasks.every((x) => !('steps' in x)));
  assert.equal(s.tasks[1].lastNote, undefined);
});
