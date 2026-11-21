import { useEffect, useMemo, useState } from 'react';
import { buildTermIndex, describeConflict, isTerm, type TermIndex } from '@shared/glossary.js';
import { api, NotFound, type Design, type Item, type Plan, type Sprint } from './api';
import { escMd } from './markdown';
import type { Board } from './model';

export type BoardState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; board: Board; live: boolean };

const ENTITY_LIST = { item: 'items', design: 'designs', plan: 'plans', sprint: 'sprints' } as const;
type Entity = keyof typeof ENTITY_LIST;

async function loadBoard(slug: string, signal: AbortSignal): Promise<Board> {
  const [config, items, designs, plans, sprints] = await Promise.all([
    api.config(slug, signal),
    api.items(slug, signal),
    api.designs(slug, signal),
    api.plans(slug, signal),
    api.sprints(slug, signal),
  ]);
  return { slug, config, items, designs, plans, sprints };
}

/** Replace or remove one record in its list, keeping the list's order. */
function apply(board: Board, entity: Entity, id: string, record: Item | Design | Plan | Sprint | null): Board {
  const key = ENTITY_LIST[entity];
  const list = board[key] as { id: string }[];
  const at = list.findIndex((x) => x.id === id);
  let next: { id: string }[];
  if (record === null) next = at === -1 ? list : list.filter((x) => x.id !== id);
  else if (at === -1) next = [...list, record];
  else next = list.map((x, i) => (i === at ? record : x));
  return { ...board, [key]: next };
}

/**
 * One board, kept current. The event stream (/api/boards/{slug}/events) says what changed, in 0.x's
 * shape; the hook then fetches that one record, the same way 0.x's dashboard did. A "resync", or a
 * stream that comes back after a drop, loads the whole board again.
 */
export function useBoard(slug: string): BoardState {
  const [state, setState] = useState<BoardState>({ status: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    let es: EventSource | null = null;
    let wasOpen = false;
    setState({ status: 'loading' });

    const reload = () =>
      loadBoard(slug, ctrl.signal).then(
        (board) => setState((s) => ({ status: 'ready', board, live: s.status === 'ready' ? s.live : false })),
        (e: unknown) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof NotFound) setState({ status: 'missing' });
          else setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        },
      );

    reload().then(() => {
      if (ctrl.signal.aborted) return;
      es = new EventSource(api.eventsUrl(slug));
      es.onopen = () => {
        if (wasOpen) void reload();
        wasOpen = true;
        setState((s) => (s.status === 'ready' ? { ...s, live: true } : s));
      };
      es.onerror = () => setState((s) => (s.status === 'ready' ? { ...s, live: false } : s));
      es.onmessage = async (ev) => {
        const { entity, id, action } = JSON.parse(ev.data) as { entity: string; id: string; action: string };
        if (action === 'resync') return void reload();
        if (!(entity in ENTITY_LIST)) return;
        const e = entity as Entity;
        let record: Item | Design | Plan | Sprint | null = null;
        if (action !== 'delete' && action !== 'archive') {
          try {
            record = await api.one(slug, e, id);
          } catch (err) {
            if (!(err instanceof NotFound)) return;
          }
        }
        setState((s) => (s.status === 'ready' ? { ...s, board: apply(s.board, e, id, record) } : s));
      };
    });

    return () => {
      ctrl.abort();
      es?.close();
    };
  }, [slug]);

  return state;
}

/**
 * The compiled glossary matcher. Rebuilt only when a term changes, not on every ticket edit: the
 * signature covers term ids and their updatedAt, as in 0.x.
 */
export function useTermIndex(items: Item[] | undefined): TermIndex | null {
  const terms = useMemo(() => (items || []).filter(isTerm), [items]);
  const sig = useMemo(() => terms.map((t) => `${t.id}:${t.updatedAt || ''}`).join(';'), [terms]);
  return useMemo(() => {
    if (!terms.length) return null;
    const index = buildTermIndex(terms, { transform: escMd });
    for (const c of index.conflicts) console.warn('[glossary]', describeConflict(c));
    return index;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
