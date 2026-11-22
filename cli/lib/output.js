// What pm prints for lists, the glossary and a project's overview.
import { buildTermIndex, findTermMatches, firstMatchPerTerm, describeConflict, signpostHint } from './glossary.js';
import { api, flags, state } from './runtime.js';

// --- List formatter ---
// Terse "ID  title" output sorted oldest→newest so the most recent items
// land at the bottom (closest to the prompt, survive tail-truncation).
// --json prints raw unsorted JSON (back-compat for scripts).
// Default limit 20; --limit N or --all override.
const LIST_DEFAULT_LIMIT = 20;
export function printList(items) {
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
  const all = flags.all === 'true';
  const limit = flags.limit ? parseInt(flags.limit, 10) : LIST_DEFAULT_LIMIT;
  let display = sorted;
  let hidden = 0;
  if (!all && Number.isFinite(limit) && limit > 0 && sorted.length > limit) {
    hidden = sorted.length - limit;
    display = sorted.slice(-limit);
  }
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

// Terms mentioned in what `pm get` just printed. Written to stderr so stdout
// stays pure JSON — agents pipe `pm get X | jq` and still see the footer.
export async function printGlossaryFooter(entity) {
  if (!entity || typeof entity !== 'object') return;
  const terms = await fetchTerms().catch(() => []);
  if (terms.length === 0) return;
  const scanned = [
    entity.title || entity.name || '',
    entity.body || entity.description || '',
    ...(Array.isArray(entity.comments) ? entity.comments.map(c => c?.text || '') : [])
  ].join('\n');
  const index = buildTermIndex(terms);
  const mentioned = firstMatchPerTerm(findTermMatches(scanned, index));
  if (mentioned.length === 0) return;
  const parts = mentioned.map(m =>
    `${m.termId} ${m.title}${m.kind === 'signpost' ? ` (${signpostHint(m.targetTitles)})` : ''}`);
  process.stderr.write(`\nGlossary: ${parts.join(' · ')}\n`);
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
