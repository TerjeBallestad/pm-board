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
import { cx, emptyInline, hoverRow, monoDim, plainButton } from '../classes';
import { navigate } from '../router';
import { relativeTime } from '../time';

export const VIEWS = [
  { view: 'inbox', label: 'Inbox', dot: 'dashed' as const, color: 'var(--gray-23)' },
  { view: 'tickets', label: 'Tickets', dot: 'solid' as const, color: 'var(--gray-23)' },
  { view: 'documents', label: 'Documents', dot: 'solid' as const, color: 'var(--bg-accent)' },
  { view: 'plans', label: 'Plans', dot: 'solid' as const, color: 'var(--bg-green)' },
  { view: 'decisions', label: 'Decisions', dot: 'solid' as const, color: 'var(--blue-9)' },
  { view: 'glossary', label: 'Glossary', dot: 'solid' as const, color: 'var(--bg-green)' },
  { view: 'archive', label: 'Archive', dot: 'solid' as const, color: 'var(--gray-22)' },
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
    <aside className="pm-sidebar flex flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-sidebar px-2.5 py-3.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-2.5">
        <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.25 border-0 bg-transparent p-0 text-left" onClick={() => navigate('/')} title="All boards">
          <span className="size-4.5 shrink-0 rounded-chip bg-linear-135/srgb from-indigo-9 to-purple-9" />
          <span className="truncate text-heading">{board.config.name || board.slug}</span>
        </button>
        <span data-live={live} title={live ? 'Live: changes appear as they happen' : 'Not connected: reload to see changes'}>
          <StatusDot state={live ? 'live' : 'outline'} color={live ? 'var(--bg-green)' : 'var(--gray-22)'} size={7} />
        </span>
      </div>
      <button className="mx-1 mb-3 flex cursor-pointer items-center justify-between rounded-md border border-input bg-input px-2.5 py-1.5 text-body text-muted" onClick={onQuickOpen}>
        <span>Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <nav className="pm-nav flex flex-col gap-px">
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
      <SectionLabel className="mt-3.5">Projects</SectionLabel>
      <div className="pm-projects flex flex-col gap-px">
        {shown.map((p) => {
          const { resolved, total } = projectProgress(p);
          const active = view === 'project' && projectId === p.id;
          const done = p.status !== 'active';
          return (
            <NavRow
              key={p.id}
              label={
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className={cx(monoDim, 'shrink-0')}>{done ? '✓' : `${resolved}/${total}`}</span>
                </span>
              }
              active={active}
              dot={<StatusDot state={done ? 'solid' : 'live'} color={done ? 'var(--gray-22)' : active ? 'var(--bg-accent)' : 'var(--bg-green)'} size={7} />}
              count={null}
              onClick={() => navigate(`/${board.slug}/project/${p.id}`)}
            />
          );
        })}
        {projects.length > shown.length && <div className="px-2.5 py-1 text-caption text-muted">+ {projects.length - shown.length} more — ⌘K to jump</div>}
        {projects.length === 0 && <div className="px-2.5 py-1 text-caption text-muted">No open projects.</div>}
      </div>
      <SectionLabel className="mt-3.5">Kinds</SectionLabel>
      <div className="flex flex-col gap-px">
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
        <span className="truncate text-heading">{p?.name || 'Project'}</span>
        {p && (
          <button className="cursor-pointer border-0 bg-transparent font-mono text-caption text-accent" onClick={() => open(p.id)}>
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
        <span className="truncate text-heading">{TITLES[view]}</span>
        {sub[view] && <span className="pm-topbar-sub whitespace-nowrap text-body text-muted">{sub[view]}</span>}
      </>
    );
  }
  return (
    <header className="pm-topbar flex h-(--topbar-h) shrink-0 items-center gap-3 border-b border-subtle px-4.5">
      {left}
      <div className="ml-auto flex items-center gap-2.5">
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
        <SearchInput placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-50" />
        <span className="pm-readonly cursor-help rounded-chip border border-dashed border-strong px-1.75 py-0.5 font-mono text-tiny text-muted" title="pm 1.x shows boards read-only until the write API (PLAN-001 Task 6). Use the pm CLI to change things.">
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
    <aside className="pm-rail overflow-y-auto border-l border-subtle bg-rail px-4 py-3.5">
      {needs.length > 0 && (
        <div className="mb-4.5 rounded-lg border border-orange-9/35 bg-orange-9/6 px-3 pt-3 pb-2">
          <div className="mb-1.5 text-label text-orange uppercase">Needs you · {needs.length}</div>
          {needs.map((n) => (
            <button key={n.refId} className={cx(plainButton, 'block w-full py-1 text-body')} onClick={() => open(n.refId)}>
              {n.label} <span className="font-mono text-id" style={{ color: n.color }}>{n.refId}</span>
            </button>
          ))}
        </div>
      )}
      <SectionLabel>Activity</SectionLabel>
      <div className="mt-1.5 flex flex-col gap-1">
        {events.length === 0 && <div className={emptyInline}>No activity yet.</div>}
        {events.map((ev, i) => {
          const av = authorAvatar(ev.author);
          return (
            <button key={i} className={cx(plainButton, hoverRow, 'flex gap-2.25 px-1 py-1.75')} onClick={() => open(ev.refId)}>
              <Avatar initials={av.initial} tone={av.tone} size={18} />
              <div className="min-w-0">
                <div className="text-caption text-secondary">
                  <strong className="text-primary">{ev.author}</strong> {ev.verb} <span className="font-mono" style={{ color: refColor(board, ev.refId) }}>{ev.refId}</span>
                </div>
                <div className="line-clamp-2 text-note text-muted">{ev.text}</div>
                <div className="mt-0.5 font-mono text-tiny text-faint">{relativeTime(ev.when)}</div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
