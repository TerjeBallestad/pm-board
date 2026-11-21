import { useEffect, useMemo, useRef, useState } from 'react';
import { useBoardCtx } from '../BoardContext';
import { displayTitle, ticketKind, type Board } from '../model';
import { navigate } from '../router';

interface Candidate {
  id: string;
  title: string;
  kind: 'item' | 'sdd' | 'plan' | 'sprint';
  label: string;
}

function candidates(b: Board): Candidate[] {
  return [
    ...b.items.map((i) => ({ id: i.id, title: displayTitle(i), kind: 'item' as const, label: ticketKind(i) || i.type || 'item' })),
    ...b.designs.map((d) => ({ id: d.id, title: d.title || '', kind: 'sdd' as const, label: 'map' })),
    ...b.plans.map((p) => ({ id: p.id, title: p.title || '', kind: 'plan' as const, label: 'plan' })),
    ...b.sprints.map((s) => ({ id: s.id, title: s.name || '', kind: 'sprint' as const, label: 'project' })),
  ];
}

/** 0.x's ranking: exact key, key prefix, key substring, title prefix, title substring. */
export function rank(all: Candidate[], query: string): Candidate[] {
  if (!query) return all.slice(0, 20);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const qn = norm(query);
  const ql = query.toLowerCase();
  const scored: { c: Candidate; score: number }[] = [];
  for (const c of all) {
    const idn = norm(c.id);
    const title = c.title.toLowerCase();
    let score = -1;
    if (qn && idn === qn) score = 0;
    else if (qn && idn.startsWith(qn)) score = 1;
    else if (qn && idn.includes(qn)) score = 2;
    else if (title.startsWith(ql)) score = 3;
    else if (title.includes(ql)) score = 4;
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.id.localeCompare(b.c.id, undefined, { numeric: true }));
  return scored.slice(0, 20).map((s) => s.c);
}

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const { board, open } = useBoardCtx();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const all = useMemo(() => candidates(board), [board]);
  const results = useMemo(() => rank(all, q.trim()), [all, q]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (c: Candidate) => {
    onClose();
    if (c.kind === 'sprint') navigate(`/${board.slug}/project/${c.id}`);
    else open(c.id);
  };
  return (
    <div className="pm-qo-backdrop" onClick={onClose}>
      <div className="pm-qo" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="pm-qo-input"
          placeholder="Jump to a ticket, map, plan or project…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            else if (e.key === 'Enter' && results[sel]) choose(results[sel]);
          }}
        />
        <div className="pm-qo-results" ref={list}>
          {results.length === 0 && <div className="pm-empty-inline">No matches</div>}
          {results.map((c, i) => (
            <button key={`${c.kind}:${c.id}`} data-selected={i === sel} className={`pm-qo-row${i === sel ? ' pm-qo-selected' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(c)}>
              <span className="pm-qo-id">{c.id}</span>
              <span className="pm-qo-title">{c.title}</span>
              <span className="pm-qo-kind">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
