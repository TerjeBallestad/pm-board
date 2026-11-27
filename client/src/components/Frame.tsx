import { Avatar, Kbd, NavRow, SearchInput, SectionLabel, SegToggle, StatusDot } from '@terjeballestad/bob';
import { useBoardCtx } from '../BoardContext';
import {
  authorAvatar,
  collectActivity,
  collectNeedsYou,
  computeProjects,
  isResolvedStage,
  isTicket,
  KINDS,
  kindColor,
  navCounts,
  projectProgress,
  refColor,
  ticketKind,
} from '../model';
import { navigate } from '../router';
import { relativeTime } from '../time';

export const VIEWS = [
  { view: 'inbox', label: 'Inbox', dot: 'dashed' as const, color: 'var(--text-muted)' },
  { view: 'tickets', label: 'Tickets', dot: 'solid' as const, color: 'var(--text-muted)' },
  { view: 'documents', label: 'Documents', dot: 'solid' as const, color: 'var(--bg-accent)' },
  { view: 'plans', label: 'Plans', dot: 'solid' as const, color: 'var(--bg-green)' },
  { view: 'decisions', label: 'Decisions', dot: 'solid' as const, color: 'var(--text-blue)' },
  { view: 'glossary', label: 'Glossary', dot: 'solid' as const, color: 'var(--bg-green)' },
  { view: 'archive', label: 'Archive', dot: 'solid' as const, color: 'var(--text-faint)' },
];
export type ViewName = (typeof VIEWS)[number]['view'] | 'project';

export function Sidebar({ view, projectId, onQuickOpen }: { view: ViewName; projectId?: string; onQuickOpen: () => void }) {
  const { board, kinds, toggleKind, live } = useBoardCtx();
  const counts = navCounts(board) as Record<string, number>;
  const go = (v: string) => navigate(`/${board.slug}/${v}`);

  const projects = computeProjects(board).filter((p) => {
    if (p.id === projectId) return true;
    if (p.status !== 'active') return false;
    const { resolved, total } = projectProgress(p);
    return total === 0 || resolved < total;
  });
  const shown = projects.slice(0, 12);
  const open = board.items.filter((i) => isTicket(i, board.config) && !isResolvedStage(i.stage));

  return (
    <aside className="pm-sidebar">
      <div className="pm-brand">
        <button className="pm-boards-link" onClick={() => navigate('/')} title="All boards">
          <span className="pm-logo" />
          <span className="pm-brand-name">{board.config.name || board.slug}</span>
        </button>
        <span data-live={live} title={live ? 'Live: changes appear as they happen' : 'Not connected: reload to see changes'}>
          <StatusDot state={live ? 'live' : 'outline'} color={live ? 'var(--bg-green)' : 'var(--text-faint)'} size={7} />
        </span>
      </div>
      <button className="pm-search-btn" onClick={onQuickOpen}>
        <span>Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <nav className="pm-nav">
        {VIEWS.map((v) => (
          <NavRow
            key={v.view}
            label={v.label}
            count={v.view in counts ? counts[v.view] : null}
            active={view === v.view}
            dot={<StatusDot state={v.dot} color={v.color} size={7} square />}
            onClick={() => go(v.view)}
          />
        ))}
      </nav>
      <SectionLabel style={{ marginTop: 14 }}>Projects</SectionLabel>
      <div className="pm-projects">
        {shown.map((p) => {
          const { resolved, total } = projectProgress(p);
          const active = view === 'project' && projectId === p.id;
          const done = p.status !== 'active';
          return (
            <NavRow
              key={p.id}
              label={
                <span className="pm-proj-label">
                  <span className="pm-proj-name">{p.name}</span>
                  <span className="pm-proj-progress">{done ? '✓' : `${resolved}/${total}`}</span>
                </span>
              }
              active={active}
              dot={<StatusDot state={done ? 'solid' : 'live'} color={done ? 'var(--text-faint)' : active ? 'var(--bg-accent)' : 'var(--bg-green)'} size={7} />}
              count={null}
              onClick={() => navigate(`/${board.slug}/project/${p.id}`)}
            />
          );
        })}
        {projects.length > shown.length && <div className="pm-more">+ {projects.length - shown.length} more — ⌘K to jump</div>}
        {projects.length === 0 && <div className="pm-more">No open projects.</div>}
      </div>
      <SectionLabel style={{ marginTop: 14 }}>Kinds</SectionLabel>
      <div className="pm-kinds">
        {KINDS.map((k) => (
          <NavRow
            key={k}
            label={k}
            count={open.filter((i) => ticketKind(i) === k).length}
            active={kinds.has(k)}
            dot={<StatusDot state="solid" color={kindColor(k)} size={7} />}
            onClick={() => toggleKind(k)}
          />
        ))}
      </div>
    </aside>
  );
}

const TITLES: Record<string, string> = {
  tickets: 'Tickets',
  inbox: 'Inbox',
  documents: 'Documents',
  plans: 'Plans',
  decisions: 'Decisions',
  glossary: 'Glossary',
  archive: 'Archive',
};

export function Topbar({
  view,
  projectId,
  mode,
}: {
  view: ViewName;
  projectId?: string;
  mode?: 'map' | 'board';
}) {
  const { board, search, setSearch, open } = useBoardCtx();
  const counts = navCounts(board);
  let left;
  if (view === 'project') {
    const p = board.sprints.find((s) => s.id === projectId);
    left = (
      <>
        <span className="pm-topbar-title">{p?.name || 'Project'}</span>
        {p && (
          <button className="pm-doclink" onClick={() => open(p.id)}>
            {p.id} ↗
          </button>
        )}
      </>
    );
  } else {
    const sub: Record<string, string> = {
      tickets: `${counts.tickets} open`,
      inbox: `${counts.inbox} waiting`,
      plans: `${counts.plans} in flight`,
      decisions: `${counts.decisions} · newest carry the weight`,
      glossary: `${counts.glossary} · one word, one meaning`,
    };
    left = (
      <>
        <span className="pm-topbar-title">{TITLES[view]}</span>
        {sub[view] && <span className="pm-topbar-sub">{sub[view]}</span>}
      </>
    );
  }
  return (
    <header className="pm-topbar">
      {left}
      <div className="pm-topbar-actions">
        {view === 'project' && projectId && (
          <SegToggle
            options={[
              { value: 'map', label: 'Map' },
              { value: 'board', label: 'Board' },
            ]}
            value={mode}
            onChange={(m) => navigate(`/${board.slug}/project/${projectId}${m === 'board' ? '?mode=board' : ''}`)}
          />
        )}
        <SearchInput placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
        <span className="pm-readonly" title="pm 1.x shows boards read-only until the write API (PLAN-001 Task 6). Use the pm CLI to change things.">
          read-only
        </span>
      </div>
    </header>
  );
}

export function Rail() {
  const { board, open } = useBoardCtx();
  const needs = collectNeedsYou(board);
  const events = collectActivity(board);
  return (
    <aside className="pm-rail">
      {needs.length > 0 && (
        <div className="pm-needs">
          <div className="pm-needs-title">Needs you · {needs.length}</div>
          {needs.map((n) => (
            <button key={n.refId} className="pm-needs-row" onClick={() => open(n.refId)}>
              {n.label} <span style={{ color: n.color }}>{n.refId}</span>
            </button>
          ))}
        </div>
      )}
      <SectionLabel>Activity</SectionLabel>
      <div className="pm-activity">
        {events.length === 0 && <div className="pm-empty-inline">No activity yet.</div>}
        {events.map((ev, i) => {
          const av = authorAvatar(ev.author);
          return (
            <button key={i} className="pm-act-row" onClick={() => open(ev.refId)}>
              <Avatar initials={av.initial} tone={av.tone} size={18} />
              <div className="pm-act-body">
                <div className="pm-act-line">
                  <strong>{ev.author}</strong> {ev.verb} <span style={{ color: refColor(board, ev.refId), fontFamily: 'var(--mono)' }}>{ev.refId}</span>
                </div>
                <div className="pm-act-text">{ev.text}</div>
                <div className="pm-act-when">{relativeTime(ev.when)}</div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
