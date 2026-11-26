// What pm prints for lists, the glossary and a project's overview.
import { buildTermIndex, findTermMatches, firstMatchPerTerm, describeConflict, signpostHint } from './glossary.js';
import { closest } from './help.js';
import { api, httpJson, boardPath, BASE_URL, flags, state } from './runtime.js';

// --- List formatter ---
// Terse "ID  title" output sorted oldest→newest so the most recent items
// land at the bottom (closest to the prompt, survive tail-truncation).
// --json prints raw unsorted JSON (back-compat for scripts).
// Default limit 20; --limit N or --all override.
const LIST_DEFAULT_LIMIT = 20;
// The fields printList reads: the server sends only these when it cuts (DD-029).
export const LIST_FIELDS = ['id', 'title', 'name', 'createdAt', 'updatedAt'];

/** How many rows pm list prints: the newest N, or null for every row (--all, --json, --limit 0). */
export function listLimit() {
  if (flags.json === 'true' || flags.all === 'true') return null;
  const limit = flags.limit ? parseInt(flags.limit, 10) : LIST_DEFAULT_LIMIT;
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** { items, total }: total counts the rows before the server cut them, when it did. */
export function printList({ items, total }) {
  if (flags.json === 'true') {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    process.stdout.write('(none)\n');
    return;
  }
  const sortKey = (it) => it.updatedAt || it.createdAt || '';
  const sorted = [...items].sort((a, b) => {
    const av = sortKey(a);
    const bv = sortKey(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  const limit = listLimit();
  const display = limit && sorted.length > limit ? sorted.slice(-limit) : sorted;
  const hidden = (total ?? sorted.length) - display.length;
  if (hidden > 0) {
    process.stdout.write(`… ${hidden} older hidden (use --all or --limit N)\n`);
  }
  const idWidth = Math.max(...display.map(it => String(it.id || '').length));
  for (const it of display) {
    const id = String(it.id || '').padEnd(idWidth);
    const title = it.title || it.name || '(untitled)';
    process.stdout.write(`${id}  ${title}\n`);
  }
}

// --- Glossary ---
// Terms are surfaced two ways, never by rewriting stored prose: `pm glossary`
// dumps the whole vocabulary (20-40 entries — an agent reads it once and holds
// it), and `pm get` footnotes the terms it just printed.
export async function fetchTerms() {
  const items = await api('GET', '/api/items?type=term', undefined, { silent: true });
  return Array.isArray(items) ? items : [];
}

export function printGlossary(terms) {
  if (flags.json === 'true') {
    process.stdout.write(JSON.stringify(terms, null, 2) + '\n');
    return;
  }
  if (terms.length === 0) {
    process.stdout.write('(no terms yet — pm create term "the-word" --body "One sentence.")\n');
    return;
  }
  const index = buildTermIndex(terms);
  const sorted = [...terms].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const idWidth = Math.max(...sorted.map(t => String(t.id || '').length));
  const titleWidth = Math.max(...sorted.map(t => String(t.title || '').length));
  for (const t of sorted) {
    const meta = index.terms.get(t.id);
    const gloss = meta?.kind === 'signpost'
      ? `⚠ ${signpostHint(meta.targetTitles)}`
      : truncate(String(t.body || '').split('\n').find(l => l.trim()) || '(undefined)', 88);
    process.stdout.write(
      `${String(t.id).padEnd(idWidth)}  ${String(t.title).padEnd(titleWidth)}  ${gloss}\n`
    );
  }
  for (const c of index.conflicts) {
    process.stderr.write(`warning: ${describeConflict(c)}\n`);
  }
}

// `pm glossary <word>`: one term, found by its title, an alias or its id. Case and runs of
// whitespace do not count, as in glossary.js. A miss names the closest term (DD-029).
const surfaceKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
export function printTerm(terms, word) {
  const index = buildTermIndex(terms);
  const key = surfaceKey(word);
  const surfacesOf = (t) => [t.title, ...(Array.isArray(t.aliases) ? t.aliases : [])].filter(s => typeof s === 'string' && s.trim());
  // glossary.js drops a surface that is too short or taken; such a word still finds its term here.
  const id = index.bySurface.get(key)
    ?? terms.find(t => String(t.id).toLowerCase() === key)?.id
    ?? terms.find(t => surfacesOf(t).some(s => surfaceKey(s) === key))?.id;
  const term = id && terms.find(t => t.id === id);
  if (!term) {
    const owner = new Map();
    for (const t of terms) for (const s of surfacesOf(t)) if (!owner.has(s)) owner.set(s, t);
    const near = closest(key, [...owner.keys()])
      ?? [...owner.keys()].filter(s => surfaceKey(s).includes(key)).sort((a, b) => a.length - b.length)[0];
    const hint = near ? ` Did you mean: ${owner.get(near).title} (${owner.get(near).id})?` : '';
    process.stderr.write(`No term "${String(word).trim()}".${hint}\nEvery term: pm glossary\n`);
    process.exit(1);
  }
  if (flags.json === 'true') {
    process.stdout.write(JSON.stringify(term, null, 2) + '\n');
    return;
  }
  const meta = index.terms.get(term.id);
  const out = [`${term.id}  ${meta.title}`];
  const aliases = surfacesOf(term).slice(term.title ? 1 : 0);
  if (aliases.length) out.push(`Aliases: ${aliases.join(', ')}`);
  if (meta.kind === 'signpost') out.push(`⚠ ${signpostHint(meta.targetTitles)} (${meta.targets.join(', ')})`);
  else out.push(String(term.body || '').trim() || '(undefined)');
  process.stdout.write(out.join('\n') + '\n');
}

// Terms mentioned in what `pm get` just printed. Written to stderr so stdout
// stays pure JSON — agents pipe `pm get X | jq` and still see the footer.
export async function printGlossaryFooter(entity) {
  if (!entity || typeof entity !== 'object') return;
  const scanned = [
    entity.title || entity.name || '',
    entity.body || entity.description || '',
    ...(Array.isArray(entity.comments) ? entity.comments.map(c => c?.text || '') : [])
  ].join('\n');
  const mentioned = await termsMentioned(scanned);
  if (mentioned.length === 0) return;
  const parts = mentioned.map(m =>
    `${m.termId} ${m.title}${m.kind === 'signpost' ? ` (${signpostHint(m.targetTitles)})` : ''}`);
  process.stderr.write(`\nGlossary: ${parts.join(' · ')}\n`);
}

// The server finds the terms with glossary.js's rules (DD-029), so pm get downloads the few the
// record mentions, not every term. A server without the route: every term, matched here.
async function termsMentioned(text) {
  const r = await httpJson('POST', `${BASE_URL}${boardPath('/api/glossary/match')}`, { text }).catch(() => null);
  if (r?.status === 200 && Array.isArray(r.data)) return r.data;
  const terms = await fetchTerms().catch(() => []);
  if (terms.length === 0) return [];
  return firstMatchPerTerm(findTermMatches(text, buildTermIndex(terms)));
}

// --- Sprint/project overview formatter ---
// Progressive disclosure for agents: `pm project` prints a one-line-per-entity
// overview (stage, open blockers, plan progress) instead of the full JSON dump
// with every body/comment inlined. Drill down with `pm get <id>`; --json keeps
// the raw detail for scripts.
export function truncate(str, len) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}
export function printSprintOverview(detail) {
  const out = [];
  const { items = [], designs = [], plans = [], ...sprint } = detail;
  out.push(`${sprint.id}  ${sprint.name}  (${sprint.status})`);
  if (sprint.problemStatement) out.push(`Destination: ${truncate(sprint.problemStatement, 200)}`);

  const itemsById = new Map(items.map(i => [i.id, i]));
  // A blocker only matters while it isn't done; unknown ids (outside this
  // sprint) are kept — we can't prove they're resolved.
  const openBlockers = (it) => (it.blockedBy || []).filter(b => {
    const dep = itemsById.get(b);
    return !dep || dep.stage !== 'done';
  });
  const stageOrder = state.config?.stages || [];
  const stageRank = (s) => {
    const idx = stageOrder.indexOf(s);
    return idx === -1 ? stageOrder.length : idx;
  };

  if (items.length) {
    const done = items.filter(i => i.stage === 'done').length;
    out.push('', `Items (${done}/${items.length} done):`);
    const sorted = [...items].sort((a, b) =>
      stageRank(a.stage) - stageRank(b.stage) || String(a.id).localeCompare(b.id));
    const idWidth = Math.max(...sorted.map(i => String(i.id).length));
    const stageWidth = Math.max(...sorted.map(i => String(i.stage || '?').length));
    for (const it of sorted) {
      const cols = [
        `  ${String(it.id).padEnd(idWidth)}`,
        String(it.stage || '?').padEnd(stageWidth),
        truncate(it.title, 76)
      ];
      if (it.priority) cols.push(`[${it.priority}]`);
      const blockers = openBlockers(it);
      if (blockers.length && it.stage !== 'done') cols.push(`⊘ blocked by ${blockers.join(', ')}`);
      if (it.assignee && it.stage !== 'done') cols.push(`⚑ ${it.assignee}`);
      out.push(cols.join('  '));
    }
  }

  if (designs.length) {
    out.push('', `Designs (${designs.length}):`);
    for (const d of designs) out.push(`  ${d.id}  ${truncate(d.title, 76)}`);
  }
  if (plans.length) {
    out.push('', `Plans (${plans.length}):`);
    for (const p of plans) {
      const tasks = p.tasks || [];
      const progress = tasks.length ? `  tasks ${tasks.filter(t => t.passes).length}/${tasks.length}` : '';
      out.push(`  ${p.id}  ${truncate(p.title, 76)}${progress}`);
    }
  }
  if (sprint.comments?.length) out.push('', `Comments: ${sprint.comments.length} (see --json)`);
  if (sprint.body) out.push(`Project doc: ${sprint.body.length} chars (see --json)`);
  out.push('', `Drill down: pm get <id> · full JSON: pm project ${sprint.id} --json`);
  process.stdout.write(out.join('\n') + '\n');
}

// --- Plans (PLAN-003 Task 4, DD-026) ---
// A plan read in full is often 50 to 80 KB: every task with its steps and notes. An agent works on
// one task at a time, so pm plan and pm next-task show the plan's shape and the next task, and say
// how to read the rest.

/** The next task: the first in plan order that has not passed and whose blockers all passed. */
export function nextOf(answer) {
  return (answer?.tasks || []).find(t => !t.passes && t.unblocked) || null;
}

function lastNote(t) {
  const notes = t.progressNotes || [];
  return notes.length ? truncate(notes[notes.length - 1].text, 200) : undefined;
}

/** `pm plan <id>`: one line per task, then the next task and the commands to read more. */
export function printPlanOverview(plan, next) {
  const out = [];
  const tasks = next?.tasks || plan.tasks || [];
  const passed = tasks.filter(t => t.passes).length;
  out.push(`${plan.id}  ${plan.title}  (${plan.stage || '?'})`);
  const meta = [];
  if (plan.sprintId) meta.push(`Project: ${plan.sprintId}`);
  if (plan.sddId) meta.push(`Design: ${plan.sddId}`);
  meta.push(`Tasks: ${passed}/${tasks.length} passed`);
  out.push(meta.join(' · '));
  const ctx = plan.context || {};
  const text = (v) => (Array.isArray(v) ? v.join('\n') : String(v || ''));
  if (text(ctx.setupNotes).trim()) out.push(`Setup notes: ${truncate(text(ctx.setupNotes), 240)} (${text(ctx.setupNotes).length} chars)`);
  if (text(ctx.designDecisions).trim()) out.push(`Design decisions: ${truncate(text(ctx.designDecisions), 160)} (${text(ctx.designDecisions).length} chars)`);
  if (Array.isArray(ctx.relevantFiles) && ctx.relevantFiles.length) {
    out.push(`Relevant files: ${truncate(ctx.relevantFiles.join(', '), 160)}${ctx.relevantFiles.length > 3 ? ` (${ctx.relevantFiles.length})` : ''}`);
  }

  if (tasks.length) {
    out.push('', 'Tasks:');
    const idWidth = Math.max(...tasks.map(t => String(t.id).length));
    const statusWidth = Math.max(...tasks.map(t => String(t.status || '?').length));
    for (const t of tasks) {
      const cols = [
        `  ${String(t.id).padEnd(idWidth)}`,
        String(t.status || '?').padEnd(statusWidth),
        t.passes ? '✓' : ' ',
        truncate(t.title, 76),
      ];
      if (!t.passes && t.unblocked === false && (t.blockedBy || []).length) cols.push(`⊘ blocked by ${t.blockedBy.join(', ')}`);
      out.push(cols.join('  '));
    }
  }
  const n = nextOf(next);
  if (n) out.push('', `Next: ${n.id}  ${truncate(n.title, 76)}`);
  else if (tasks.length && passed === tasks.length) out.push('', 'Every task passed.');
  else if (tasks.length) out.push('', 'No task can start: each open task waits for another.');
  if (plan.comments?.length) out.push(`Comments: ${plan.comments.length} (see --json)`);
  out.push('', `Drill down: pm get TASK-NNN · next task in full: pm next-task ${plan.id} · full JSON: pm plan ${plan.id} --json`);
  process.stdout.write(out.join('\n') + '\n');
}

/** `pm next-task <id>`: the next task in full, and every task in one short entry. */
export function nextTaskSummary(planId, answer) {
  const n = nextOf(answer);
  return {
    planId,
    planTitle: answer.planTitle,
    progress: answer.progress,
    allComplete: answer.allComplete,
    next: n,
    tasks: (answer.tasks || []).map(t => {
      const o = { id: t.id, title: t.title, status: t.status, passes: Boolean(t.passes), unblocked: t.unblocked };
      if ((t.blockedBy || []).length) o.blockedBy = t.blockedBy;
      if (t.passes || t.status === 'done') o.lastNote = lastNote(t);
      return o;
    }),
    designDecisions: answer.designDecisions,
    relevantFiles: answer.relevantFiles,
    references: answer.references,
    more: `One task in full: pm get TASK-NNN. Every task in full: pm next-task ${planId} --json`,
  };
}

// --- Write receipts (PLAN-003 Task 5, DD-027) ---
// A write echoed the whole record: claim 2.4 KB on average, task-update up to 14 KB with every
// progress note. The agent knows what it sent; it needs the key and what the server made of it.
// --json prints the server's answer, as before 1.1.

/** Print one line for a write, or the server's answer with --json. */
export function printWrite(answer, text) {
  if (flags.json === 'true') {
    process.stdout.write(JSON.stringify(answer, null, 2) + '\n');
  } else {
    process.stdout.write(text + '\n');
  }
}

/** One field's new value, short: a body as its size, a list joined, nothing as ''. */
function shortValue(key, v) {
  if (v === null || v === undefined || v === '') return "''";
  if (key === 'body' || key === 'description' || key === 'context') {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `(${s.length} chars)`;
  }
  if (Array.isArray(v)) return v.length ? truncate(v.map(x => (typeof x === 'object' ? x.id || JSON.stringify(x) : x)).join(','), 80) : "''";
  if (typeof v === 'object') return truncate(JSON.stringify(v), 80);
  const text = truncate(String(v), 80);
  // A comma inside a value would read as the next field.
  return text.includes(',') ? JSON.stringify(text) : text;
}

// The request names some fields otherwise than the record does.
const FIELD_OF = { sprint: 'sprintId', files: 'affectedFiles', items: 'itemIds' };

// The body guard's fields (DD-030): a block added reads as its size; the base and force say nothing.
const BODY_BLOCK = { bodyPrepend: 'prepended', bodyAppend: 'appended' };
const UNPRINTED = new Set(['bodyBase', 'force']);

/** `stage done, priority high, body (120 chars)`: each field sent, as the answer has it. */
export function changes(sent, answer) {
  return Object.keys(sent)
    .filter((k) => !UNPRINTED.has(k))
    .map((k) => {
      if (k in BODY_BLOCK) return `body ${BODY_BLOCK[k]} ${shortValue('body', sent[k])}`;
      const field = FIELD_OF[k] || k;
      const v = answer && field in answer ? answer[field] : sent[k];
      if (field === 'tasks' && Array.isArray(v)) return `tasks (${v.length})`;
      return `${field} ${shortValue(field, v)}`;
    })
    .join(', ');
}

/** When a claim ends: assignedAt plus the board's claimTtlHours, or never. */
export function claimEnd(item) {
  const ttl = Number(state.config?.claimTtlHours);
  if (!item?.assignedAt || !(ttl > 0)) return 'with no expiry';
  return `until ${new Date(Date.parse(item.assignedAt) + ttl * 3600 * 1000).toISOString()}`;
}

/** archive and sweep: how many went, and which. */
export function archived(answer, none) {
  const ids = answer?.ids || [];
  return ids.length ? `archived ${ids.length}: ${truncate(ids.join(', '), 200)}` : none;
}
