// Help and "did you mean", rendered from the command table (DD-023, DD-025).
import { VERSION, DEFAULT_URL, state } from './runtime.js';

/** Edit distance with transpositions, so `lsit` is one step from `list`. */
export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The closest candidate to `word`, or null when none is close. */
export function closest(word, candidates) {
  const w = String(word).toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(w, c.toLowerCase());
    if (d < bestD) { best = c; bestD = d; }
  }
  const limit = w.length <= 4 ? 1 : 2;
  if (bestD <= limit) return best;
  // A prefix of a longer name: `next` for `next-task`, `task` for `task-update`.
  const prefixed = candidates.filter(c => c.startsWith(w) && w.length >= 3);
  return prefixed.length === 1 ? prefixed[0] : null;
}

// Words agents try that are not commands, and the command they want (the usage study in PLAN-003).
export const GUESSES = {
  ls: 'list', view: 'get', open: 'get', cat: 'get', read: 'get', find: 'list', search: 'list',
  new: 'create', add: 'create', edit: 'patch', set: 'patch', close: 'patch', done: 'task-done',
  rm: 'archive', remove: 'archive', delete: 'archive', status: 'project', tasks: 'plan',
  version: '--version', frontier: 'ready', next: 'next-task', note: 'comment', unclaim: 'release',
};

// Flags agents try, and the flag they want, where the command has it.
export const FLAG_GUESSES = {
  status: 'stage', state: 'stage', label: 'as', assignee: 'as', who: 'author', by: 'author',
  sprintId: 'sprint', project: 'sprint', text: 'body', description: 'body', desc: 'body', message: 'body',
  blocked: 'blockedBy', 'blocked-by': 'blockedBy', blockedby: 'blockedBy', depends: 'blockedBy', n: 'limit', count: 'limit',
};

function line(left, right, width = 34) {
  if (!right) return `  ${left}`;
  return left.length <= width - 2
    ? `  ${left.padEnd(width - 2)}  ${right}`
    : `  ${left}\n  ${''.padEnd(width - 2)}  ${right}`;
}

/** `pm help` / `pm --help`: one line per command, by group. */
export function renderUsage(commands, groups) {
  const out = [];
  out.push(`${state.config?.name || 'PM Board'} — pm ${VERSION}`, '');
  out.push('Usage: pm <command> [args] [--flags]');
  out.push('       pm help <command>, or pm <command> --help, for its flags and examples', '');
  for (const group of groups) {
    const cmds = commands.filter(c => c.group === group && !c.hidden);
    if (!cmds.length) continue;
    out.push(`${group}:`);
    for (const c of cmds) out.push(line(c.synopsis, c.summary));
    out.push('');
  }
  out.push('Board and server:');
  out.push(line('--board <slug>', 'Use this board, not the one in .pm.json'));
  out.push(line('--server <url>', 'Use this server, as PM_URL does'), '');
  out.push('Environment:');
  out.push(line('PM_URL', `Server URL (default: ${DEFAULT_URL})`));
  out.push(line('PM_TOKEN', 'Token for writes'));
  out.push('  ~/.config/pm/config.json holds this machine\'s {"url", "token"}; the variables win.');
  return out.join('\n') + '\n';
}

/** `pm help <command>`: its usage, what it does, its flags, examples and other names. */
export function renderCommandHelp(c) {
  const out = [`Usage: ${[].concat(c.usage).map((u, i) => (i ? '       pm ' : 'pm ') + u).join('\n')}`, ''];
  out.push(typeof c.help === 'function' ? c.help() : c.help || c.summary);
  if (c.flagHelp?.length) {
    out.push('', 'Flags:');
    for (const [f, text] of c.flagHelp) out.push(line(f, text, 26));
  }
  if (c.examples?.length) {
    out.push('', 'Examples:');
    for (const e of c.examples) out.push(`  ${e}`);
  }
  if (c.aliases?.length) out.push('', `Also: ${c.aliases.map(a => `pm ${a}`).join(', ')}`);
  return out.join('\n').replace(/\n*$/, '\n');
}
