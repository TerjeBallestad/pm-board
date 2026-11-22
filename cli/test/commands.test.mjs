// The command table (DD-025, DD-028): every command in the help can explain itself, and nothing
// in the help points at a command that was removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, GROUPS } from '../lib/commands.js';
import { renderUsage, renderCommandHelp } from '../lib/help.js';

const shown = COMMANDS.filter(c => !c.hidden);
const removed = COMMANDS.filter(c => c.removed);
const names = (c) => [c.name, ...(c.aliases || []), ...(c.hiddenAliases || [])];

test('every command in the help has a group, a synopsis, a usage and a summary', () => {
  for (const c of shown) {
    assert.ok(GROUPS.includes(c.group), `${c.name}: group ${c.group}`);
    for (const key of ['synopsis', 'usage', 'summary']) assert.ok([].concat(c[key] ?? []).join('').trim(), `${c.name}: no ${key}`);
    assert.ok(c.synopsis.startsWith(c.name), `${c.name}: synopsis ${c.synopsis}`);
    assert.ok(renderCommandHelp(c).startsWith(`Usage: pm ${c.name}`), `${c.name}: help`);
    assert.equal(typeof c.run, 'function', `${c.name}: no handler`);
  }
});

test('no two commands share a name', () => {
  const all = COMMANDS.flatMap(names);
  assert.deepEqual(all.filter((n, i) => all.indexOf(n) !== i), []);
});

test('a removed command is hidden, takes any argument, and names what to use instead', () => {
  assert.ok(removed.length > 0);
  for (const c of removed) {
    assert.equal(c.hidden, true, c.name);
    assert.equal(c.board, false, c.name);
    assert.equal(c.anyFlags, true, c.name);
    assert.match(c.removed, /^pm [a-z]/, c.name);
  }
});

test('no help text names a removed command', () => {
  const words = removed.map(c => c.name);
  const texts = [renderUsage(COMMANDS, GROUPS), ...COMMANDS.filter(c => !c.removed).map(renderCommandHelp)];
  for (const text of texts) {
    for (const w of words) assert.doesNotMatch(text, new RegExp(`\\bpm ${w}\\b`), `help names pm ${w}:\n${text}`);
  }
});

test('the main help lists no hidden command and no hidden alias', () => {
  const usage = renderUsage(COMMANDS, GROUPS);
  for (const c of COMMANDS.filter(c => c.hidden)) assert.doesNotMatch(usage, new RegExp(`^  ${c.name}\\b`, 'm'), c.name);
  for (const c of COMMANDS) {
    for (const a of c.hiddenAliases || []) assert.doesNotMatch(renderCommandHelp(c), new RegExp(`\\bpm ${a}\\b`), `${c.name} shows ${a}`);
  }
});
