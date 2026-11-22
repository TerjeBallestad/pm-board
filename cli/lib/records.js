// Record types, the routes for an id, and the request bodies that flags make.
import { readFileSync } from 'fs';
import { api, apiResponse, flags, state, isRequestFlag, usageError } from './runtime.js';
import { listLimit, LIST_FIELDS } from './output.js';

// --- List type resolution ---
// Canonical list types: 'sdd', 'plan', 'sprint', plus per-config item types
// (e.g. 'issue', 'decision', 'concern', 'gap'). The resolver accepts prefix
// codes, labels, singulars, plurals, mixed case — anything an agent might
// reasonably guess. Only the canonical positional form is documented; the
// rest "just work."
const RESERVED_LIST_TYPES = {
  sdd: 'sdd', sdds: 'sdd', design: 'sdd', designs: 'sdd',
  plan: 'plan', plans: 'plan',
  sprint: 'sprint', sprints: 'sprint', project: 'sprint', projects: 'sprint'
};
// Structural entities have dedicated commands and their own API collections.
const STRUCTURAL_PREFIXES = ['SDD', 'PLAN', 'SPRINT', 'TASK', 'MILESTONE'];

// The server answers config with the board's types merged over 0.x's defaults
// (BoardConfig), so the CLI resolves the same union the server mints ids from.
const DEFAULT_ENTITY_TYPES = {
  SB: { label: 'Issue' }, DD: { label: 'Decision' }, DC: { label: 'Concern' },
  GAP: { label: 'Gap' }, TERM: { label: 'Term' }
};
export function itemEntityTypes() {
  const merged = { ...DEFAULT_ENTITY_TYPES, ...(state.config?.entityTypes || {}) };
  for (const prefix of STRUCTURAL_PREFIXES) delete merged[prefix];
  return merged;
}

export function itemPrefixes() {
  return Object.keys(itemEntityTypes());
}

export function buildTypeAliases() {
  const aliases = { ...RESERVED_LIST_TYPES };
  for (const [prefix, def] of Object.entries(itemEntityTypes())) {
    const label = String(def.label || prefix).toLowerCase();
    aliases[prefix.toLowerCase()] = label;
    aliases[label] = label;
    aliases[label.endsWith('s') ? label : label + 's'] = label;
  }
  return aliases;
}
// Words that are almost certainly a mistyped subcommand, not a title.
// `pm sdd list` used to create an SDD literally titled "list".
const COMMAND_WORD_TITLES = /^(list|ls|get|show|view|open|create|new|delete|remove|rm|update|patch|edit|help|status)$/i;

export function rejectCommandWordTitle(title, typeName) {
  if (!COMMAND_WORD_TITLES.test(title)) return;
  process.stderr.write(
    `"${title}" looks like a subcommand, not a title — refusing to create a ${typeName} named "${title}".\n` +
    `  To list:   pm list ${typeName}   (or: pm ${typeName} list)\n` +
    `  To create: pm ${typeName} "a real title"\n`);
  process.exit(2);
}

export function resolveListType(input) {
  if (!input) return { canonical: null };
  const aliases = buildTypeAliases();
  const canonical = aliases[String(input).toLowerCase()];
  if (!canonical) {
    const known = [...new Set(Object.values(aliases))].sort().join(', ');
    usageError(`Unknown list type "${input}". Known: ${known}`);
  }
  return { canonical };
}
// What pm list prints: { items, total }. When it prints the newest N, the server sorts and cuts
// (DD-029) and sends only the fields printList reads; total is the number of rows before the cut
// (X-Total-Count). A server without that query answers every row, and printList cuts them itself.
export async function fetchListByType(typeArg) {
  const { canonical } = resolveListType(typeArg);
  const params = new URLSearchParams();
  let path;
  if (canonical === 'sdd') path = '/api/designs';
  else if (canonical === 'plan') {
    path = '/api/plans';
    if (flags.sprint) params.set('sprintId', flags.sprint);
  } else if (canonical === 'sprint') path = '/api/sprints';
  else {
    // Items: filter by canonical type label if specified
    path = '/api/items';
    if (canonical) params.set('type', canonical);
    if (flags.stage) params.set('stage', flags.stage);
    if (flags.priority) params.set('priority', flags.priority);
    if (flags.sprint) params.set('sprintId', flags.sprint);
    if (flags.frontier === 'true') params.set('frontier', 'true');
    if (flags['all-claims'] === 'true') params.set('allClaims', 'true');
  }
  const limit = listLimit();
  if (limit) {
    params.set('sort', 'updatedAt');
    params.set('limit', String(limit));
    params.set('fields', LIST_FIELDS.join(','));
  }
  const qs = params.toString();
  const { data, headers } = await apiResponse('GET', `${path}${qs ? '?' + qs : ''}`, undefined, { silent: true });
  const total = limit && headers?.['x-total-count'] !== undefined ? Number(headers['x-total-count']) : undefined;
  return { items: data, total: Number.isInteger(total) ? total : undefined };
}

// --- ID prefix routing ---
export function routeById(id) {
  const upper = id.toUpperCase();
  for (const prefix of itemPrefixes()) {
    if (upper.startsWith(`${prefix}-`)) return `/api/items/${id}`;
  }
  if (upper.startsWith('PLAN-')) return `/api/plans/${id}`;
  if (upper.startsWith('SDD-')) return `/api/designs/${id}`;
  if (upper.startsWith('SPRINT-')) return `/api/sprints/${id}`;
  if (upper.startsWith('TASK-')) {
    usageError('Tasks live under plans — use: pm get PLAN-NNN');
  }
  usageError(`Unknown ID prefix: ${id}`);
}

export function commentRoute(id) {
  const upper = id.toUpperCase();
  for (const prefix of itemPrefixes()) {
    if (upper.startsWith(`${prefix}-`)) return `/api/items/${id}/comments`;
  }
  if (upper.startsWith('SDD-')) return `/api/designs/${id}/comments`;
  if (upper.startsWith('PLAN-')) return `/api/plans/${id}/comments`;
  if (upper.startsWith('SPRINT-')) return `/api/sprints/${id}/comments`;
  usageError(`Comments not supported for prefix: ${id}`);
}

// --- Generic @file / - / inline expansion for string args ---
export async function expandFileArg(val, label = 'input') {
  if (val == null || val === '') return val;
  if (val === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString().trim();
  }
  if (typeof val === 'string' && val.startsWith('@')) {
    const filePath = val.slice(1);
    try {
      return readFileSync(filePath, 'utf-8');
    } catch (e) {
      process.stderr.write(`Failed to read ${label} file ${filePath}: ${e.message}\n`);
      process.exit(1);
    }
  }
  return val;
}

// --- Body resolution (inline string, @file, or - for stdin) ---
export async function resolveBody() {
  if (!flags.body) return;
  flags.body = await expandFileArg(flags.body, 'body');
}

// --- Item body builder ---
export function buildItemBody(type, title) {
  const body = { type, title };
  if (flags.priority) body.priority = flags.priority;
  if (flags.body) body.body = flags.body;
  if (flags.pillar) body.pillar = flags.pillar;
  if (flags.sprint) body.sprintId = flags.sprint;
  if (flags.files) body.affectedFiles = flags.files.split(',');
  if (flags.blockedBy) body.blockedBy = flags.blockedBy.split(',');
  return body;
}

// --- Resolve @file references for JSON array flags (e.g. --tasks @file.json) ---
export function resolveJsonFlag(key) {
  if (!flags[key]) return;
  let raw = flags[key];
  if (typeof raw === 'string' && raw.startsWith('@')) {
    const filePath = raw.slice(1);
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (e) {
      process.stderr.write(`Failed to read ${key} file ${filePath}: ${e.message}\n`);
      process.exit(1);
    }
  }
  if (typeof raw === 'string') {
    try {
      flags[key] = JSON.parse(raw);
    } catch (e) {
      usageError(`Invalid JSON for --${key}: ${e.message}`);
    }
  }
}

// --- Generic patch body builder (forwards all flags, maps known aliases) ---
export function buildPatchBody() {
  resolveJsonFlag('tasks');
  const body = {};
  for (const [key, val] of Object.entries(flags)) {
    if (!isRequestFlag(key)) continue;
    if (key === 'sprint') body.sprintId = val;
    else if (key === 'files') body.affectedFiles = val.split(',');
    else if (key === 'items') body.itemIds = val.split(',');
    else if (key === 'related') body.related = val === '' ? [] : val.split(',');
    else if (key === 'blockedBy') body.blockedBy = val === '' ? [] : val.split(',');
    else body[key] = val;
  }
  return body;
}
