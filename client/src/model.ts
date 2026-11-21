// Everything the board derives on the client, ported from 0.x's dashboard/app.js so 1.x shows the
// same thing: ticket kinds from title prefixes, the frontier split, projects (sprints), counts,
// "needs you", and the activity feed. Read-only: nothing here writes.
import type { BoardConfig, Comment, Design, Item, Plan, Sprint } from './api';

export const KINDS = ['research', 'probe', 'grill', 'task', 'gap'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_COLORS: Record<Kind, string> = {
  research: '#52a9ff',
  probe: '#c084fc',
  grill: '#f0883e',
  task: '#46c288',
  gap: '#e2c541',
};
export const DESIGN_COLOR = '#7b83eb';
export const PLAN_COLOR = '#46c288';
export const DECISION_COLOR = '#52a9ff';
export const NEUTRAL = '#9b9fad';

const HITL: ReadonlySet<string> = new Set(['grill', 'probe']);

export interface Board {
  slug: string;
  config: BoardConfig;
  items: Item[];
  designs: Design[];
  plans: Plan[];
  sprints: Sprint[];
}

/** [research]/[probe]/[grill]/[task] title prefix, or the gap type. */
export function ticketKind(item?: Item | null): Kind | null {
  if (!item) return null;
  if (item.type === 'gap') return 'gap';
  const m = /^\[(research|probe|grill|task)\]\s*/i.exec(item.title || '');
  return m ? (m[1].toLowerCase() as Kind) : null;
}

export function kindColor(kind: Kind | null | undefined): string {
  return (kind && KIND_COLORS[kind]) || NEUTRAL;
}

export function isHitl(kind: Kind | null): boolean {
  return kind !== null && HITL.has(kind);
}

/** The title with the [kind] prefix removed. */
export function displayTitle(e: { title?: string; name?: string }): string {
  return (e.title || e.name || '(untitled)').replace(/^\[(research|probe|grill|task)\]\s*/i, '');
}

/** Types with entityTypes.*.frontier = false are reference material, never work. */
export function nonFrontierTypes(config: BoardConfig): Set<string> {
  const out = new Set<string>();
  for (const [prefix, meta] of Object.entries(config.entityTypes || {})) {
    if (meta && meta.frontier === false) out.add(String(meta.label || prefix).toLowerCase());
  }
  return out;
}

export function isTicket(item: Item, config: BoardConfig): boolean {
  return item.type !== 'decision' && !nonFrontierTypes(config).has(item.type);
}

export function isResolvedStage(stage?: string): boolean {
  return stage === 'done' || stage === 'closed';
}

export function byId(items: Item[]): Map<string, Item> {
  return new Map(items.map((i) => [i.id, i]));
}

/** Blockers that still block: done, archived and unknown keys do not (the server's frontier rule). */
export function unresolvedBlockers(item: Item, index: Map<string, Item>): string[] {
  const blockers = Array.isArray(item.blockedBy) ? item.blockedBy : [];
  return blockers.filter((id) => {
    const b = index.get(id);
    return b && !isResolvedStage(b.stage);
  });
}

const byUpdated = (a: { updatedAt?: string }, b: { updatedAt?: string }) =>
  (b.updatedAt || '').localeCompare(a.updatedAt || '');

export function splitByFrontier(tickets: Item[], all: Item[]) {
  const index = byId(all);
  const frontier: Item[] = [];
  const blocked: Item[] = [];
  const resolved: Item[] = [];
  for (const t of tickets) {
    if (isResolvedStage(t.stage)) resolved.push(t);
    else if (unresolvedBlockers(t, index).length > 0) blocked.push(t);
    else frontier.push(t);
  }
  frontier.sort(byUpdated);
  blocked.sort(byUpdated);
  resolved.sort(byUpdated);
  return { frontier, blocked, resolved };
}

export interface ProjectView {
  id: string;
  name: string;
  destination: string;
  status?: string;
  tickets: Item[];
  sprint: Sprint;
}

/** A project is a sprint: the tickets, designs and plans that join it through sprintId. */
export function computeProjects(b: Board): ProjectView[] {
  const projects = b.sprints.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    destination: s.problemStatement || '',
    status: s.status,
    tickets: b.items.filter((i) => i.sprintId === s.id && isTicket(i, b.config)),
    sprint: s,
  }));
  projects.sort((x, y) => {
    const ax = x.status === 'active' ? 0 : 1;
    const ay = y.status === 'active' ? 0 : 1;
    if (ax !== ay) return ax - ay;
    return (y.sprint.createdAt || '').localeCompare(x.sprint.createdAt || '');
  });
  return projects;
}

export function projectProgress(p: ProjectView) {
  return { resolved: p.tickets.filter((t) => isResolvedStage(t.stage)).length, total: p.tickets.length };
}

export function navCounts(b: Board) {
  const open = b.items.filter((i) => isTicket(i, b.config) && !isResolvedStage(i.stage));
  return {
    inbox: open.filter((i) => i.stage === 'inbox').length,
    tickets: open.length,
    documents: b.designs.filter((d) => d.stage !== 'done').length,
    plans: b.plans.filter((p) => p.stage !== 'done').length,
    decisions: b.items.filter((i) => i.type === 'decision').length,
    glossary: b.items.filter((i) => i.type === 'term').length,
  };
}

export function matchesSearch(e: { id?: string; title?: string; name?: string }, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (e.title || e.name || '').toLowerCase().includes(s) || (e.id || '').toLowerCase().includes(s);
}

export function taskProgress(p: Plan) {
  const tasks = p.tasks || [];
  return { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length };
}

/** What kind of record a key is, by which list holds it. */
export type EntityKind = 'item' | 'design' | 'plan' | 'sprint';
export function findEntity(b: Board, id: string): { kind: EntityKind; entity: Item | Design | Plan | Sprint } | null {
  const item = b.items.find((i) => i.id === id);
  if (item) return { kind: 'item', entity: item };
  const design = b.designs.find((d) => d.id === id);
  if (design) return { kind: 'design', entity: design };
  const plan = b.plans.find((p) => p.id === id);
  if (plan) return { kind: 'plan', entity: plan };
  const sprint = b.sprints.find((s) => s.id === id);
  if (sprint) return { kind: 'sprint', entity: sprint };
  return null;
}

/** The colour of a key wherever it appears: its kind for tickets, else by record type. */
export function refColor(b: Board, id: string): string {
  const f = findEntity(b, id);
  if (!f) return NEUTRAL;
  if (f.kind === 'item') {
    const item = f.entity as Item;
    if (item.type === 'decision') return DECISION_COLOR;
    return kindColor(ticketKind(item));
  }
  if (f.kind === 'design') return DESIGN_COLOR;
  if (f.kind === 'plan') return PLAN_COLOR;
  return DESIGN_COLOR;
}

/** The copy-to-start command from the board's config ({id}/{title} templates), or null. */
export function startCommand(config: BoardConfig, entity: { id: string; title?: string; name?: string }, type: EntityKind): string | null {
  const cmds = config.commands || {};
  let tpl: string | null | undefined = null;
  if (type === 'item') {
    const t = cmds.ticket || {};
    tpl = t[ticketKind(entity as Item) ?? ''] || t.default || null;
  } else if (type === 'design') tpl = cmds.sdd;
  else if (type === 'plan') tpl = cmds.plan;
  else if (type === 'sprint') tpl = cmds.project;
  if (!tpl) return null;
  return tpl.replaceAll('{id}', entity.id || '').replaceAll('{title}', displayTitle(entity));
}

export type AvatarTone = 'gold' | 'accent' | 'green' | 'neutral';
export function authorAvatar(author?: string): { initial: string; tone: AvatarTone } {
  const a = (author || '').toLowerCase();
  if (/terje/.test(a) || a === 'user') return { initial: 'T', tone: 'gold' };
  if (/claude/.test(a)) return { initial: 'C', tone: 'accent' };
  if (/ralph|agent/.test(a)) return { initial: 'R', tone: 'green' };
  return { initial: (author || '?').charAt(0).toUpperCase(), tone: 'neutral' };
}

export interface ActivityEvent {
  when: string;
  author: string;
  text: string;
  refId: string;
  verb: string;
}

export function collectActivity(b: Board): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const push = (refId: string, c: Comment) => {
    if (!c?.createdAt) return;
    events.push({ when: c.createdAt, author: c.author || 'unknown', text: (c.text || '').split('\n')[0].slice(0, 120), refId, verb: 'commented on' });
  };
  for (const i of b.items) (i.comments || []).forEach((c) => push(i.id, c));
  for (const d of b.designs) (d.comments || []).forEach((c) => push(d.id, c));
  for (const p of b.plans) {
    (p.comments || []).forEach((c) => push(p.id, c));
    for (const t of p.tasks || []) {
      for (const n of t.progressNotes || []) {
        if (!n?.timestamp) continue;
        events.push({
          when: n.timestamp,
          author: 'agent',
          text: `${t.title ? t.title.split(':')[0] : t.id} — ${(n.text || '').split('\n')[0].slice(0, 110)}`,
          refId: p.id,
          verb: 'progressed',
        });
      }
    }
  }
  for (const i of b.items) {
    if (isTicket(i, b.config) && isResolvedStage(i.stage) && i.updatedAt) {
      events.push({ when: i.updatedAt, author: 'board', text: displayTitle(i).slice(0, 110), refId: i.id, verb: 'resolved' });
    }
  }
  events.sort((x, y) => (y.when || '').localeCompare(x.when || ''));
  return events.slice(0, 30);
}

export interface NeedsYou {
  label: string;
  refId: string;
  color: string;
}

export function collectNeedsYou(b: Board): NeedsYou[] {
  const needs: NeedsYou[] = [];
  const index = byId(b.items);
  for (const t of b.items) {
    if (!isTicket(t, b.config) || isResolvedStage(t.stage)) continue;
    const kind = ticketKind(t);
    if (!isHitl(kind)) continue;
    if (unresolvedBlockers(t, index).length > 0) continue;
    needs.push({ label: `${kind === 'grill' ? 'Grill' : 'Probe'} session on`, refId: t.id, color: kindColor(kind) });
  }
  for (const p of b.plans) {
    if (p.stage === 'done') continue;
    for (const t of p.tasks || []) {
      if (t.status === 'in_progress' && /terje|feel.?gate|play session/i.test(`${t.verification || ''} ${t.title || ''}`)) {
        needs.push({ label: 'Feel-gate on', refId: p.id, color: PLAN_COLOR });
        break;
      }
    }
  }
  for (const t of b.items) {
    if (!isTicket(t, b.config) || isResolvedStage(t.stage)) continue;
    const last = (t.comments || []).at(-1);
    if (!last) continue;
    if (authorAvatar(last.author).tone !== 'gold' && /ruling|options for|awaiting|needs terje/i.test(`${t.title} ${last.text || ''}`)) {
      needs.push({ label: 'Ruling on', refId: t.id, color: '#e6e7ec' });
    }
  }
  const seen = new Set<string>();
  return needs.filter((n) => (seen.has(n.refId) ? false : (seen.add(n.refId), true))).slice(0, 5);
}

/** Decisions grouped as 0.x does: this week, last week, then by month ("fading by design"). */
export function decisionGroups(decisions: Item[]) {
  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;
  const groups: { thisWeek: Item[]; lastWeek: Item[]; older: [string, Item[]][] } = { thisWeek: [], lastWeek: [], older: [] };
  const older = new Map<string, Item[]>();
  for (const d of decisions) {
    const t = new Date(d.updatedAt || d.createdAt || 0).getTime();
    if (now - t < week) groups.thisWeek.push(d);
    else if (now - t < 2 * week) groups.lastWeek.push(d);
    else {
      const key = new Date(t).toLocaleString(undefined, { month: 'long', year: 'numeric' });
      if (!older.has(key)) older.set(key, []);
      older.get(key)!.push(d);
    }
  }
  groups.older = [...older];
  return groups;
}
