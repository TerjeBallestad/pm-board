import { useState } from 'react';
import { ProgressBar, StatusDot } from '@terjeballestad/bob';
import type { Item } from '../api';
import { useBoardCtx } from '../BoardContext';
import {
  byId,
  computeProjects,
  DESIGN_COLOR,
  displayTitle,
  isHitl,
  kindColor,
  matchesSearch,
  projectProgress,
  splitByFrontier,
  taskProgress,
  ticketKind,
  unresolvedBlockers,
} from '../model';
import { age, cardId, cardKind, check, cx, empty, emptyInline, hint, monoDim, pcard, pcardTop, waitChip } from '../classes';
import { shortTime } from '../time';
import { TicketsView } from './Lists';

const STRIP_CAP = 4;
const execStrip = 'pm-exec-strip mb-2.5 flex flex-wrap items-center gap-2';
const execLabel = 'w-22.5 text-label text-muted uppercase';
const exec = 'inline-flex max-w-[420px] cursor-pointer items-center gap-2 rounded-md border border-strong bg-card px-2.5 py-1.25 hover:border-indigo-9';
const execId = 'shrink-0 font-mono text-tiny text-green';
const execTitle = 'truncate text-body';
const pcardFoot = 'mt-2 flex flex-wrap items-center gap-1.5';

/** A project: its destination and progress, then the map (frontier / blocked / resolved) or its kanban. */
export function ProjectView({ id, mode }: { id: string; mode: 'map' | 'board' }) {
  const { board, search, kinds, open } = useBoardCtx();
  const [expanded, setExpanded] = useState(false);
  const p = computeProjects(board).find((x) => x.id === id);
  if (!p) return <div className={empty}>Project not found — it may have been archived.</div>;
  const { resolved: done, total } = projectProgress(p);

  const strip = (
    <div className="pm-strip mb-3.5 flex items-center gap-5 border-b border-subtle px-1 pb-3.5">
      <div className="flex-1 text-base text-secondary">
        <strong className="text-primary">Destination:</strong> {p.destination || '(no destination set)'}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <ProgressBar value={done} max={Math.max(total, 1)} width={120} />
        <span className={monoDim}>
          {done}/{total} resolved
        </span>
      </div>
    </div>
  );
  if (mode === 'board') {
    return (
      <>
        {strip}
        <TicketsView projectId={id} />
      </>
    );
  }

  const tickets = p.tickets.filter((t) => matchesSearch(t, search)).filter((t) => kinds.size === 0 || kinds.has(ticketKind(t) ?? ''));
  const { frontier, blocked, resolved } = splitByFrontier(tickets, board.items);
  const hitl = frontier.filter((t) => isHitl(ticketKind(t)));
  const byDone = <T extends { stage?: string; updatedAt?: string }>(a: T, b: T) =>
    Number(a.stage === 'done') - Number(b.stage === 'done') || (b.updatedAt || '').localeCompare(a.updatedAt || '');
  const designs = board.designs.filter((d) => d.sprintId === p.id).sort(byDone);
  const plans = board.plans.filter((pl) => pl.sprintId === p.id).sort(byDone);
  const cap = <T,>(xs: T[]) => (expanded ? xs : xs.slice(0, STRIP_CAP));
  const more = (n: number, what: string) =>
    !expanded && n > STRIP_CAP ? (
      <button className={cx(exec, 'text-caption text-muted')} onClick={() => setExpanded(true)}>
        + {n - STRIP_CAP} more {what}
      </button>
    ) : null;
  const index = byId(board.items);

  return (
    <>
      {strip}
      {designs.length > 0 && (
        <div className={execStrip}>
          <span className={execLabel}>Documents</span>
          {cap(designs).map((d) => (
            <button key={d.id} className={cx(exec, d.stage === 'done' && 'opacity-55')} onClick={() => open(d.id)}>
              <span className={execId} style={{ color: DESIGN_COLOR }}>{d.id}</span>
              <span className={execTitle}>{displayTitle(d)}</span>
            </button>
          ))}
          {more(designs.length, 'docs')}
        </div>
      )}
      {plans.length > 0 && (
        <div className={execStrip}>
          <span className={execLabel}>Execution</span>
          {cap(plans).map((pl) => {
            const prog = taskProgress(pl);
            return (
              <button key={pl.id} className={cx(exec, pl.stage === 'done' && 'opacity-55')} onClick={() => open(pl.id)}>
                <span className={execId}>{pl.id}</span>
                <span className={execTitle}>{displayTitle(pl)}</span>
                <ProgressBar value={prog.done} max={Math.max(prog.total, 1)} width={40} height={3} color="var(--bg-green)" />
                <span className={monoDim}>
                  {prog.done}/{prog.total}
                </span>
              </button>
            );
          })}
          {more(plans.length, 'plans')}
        </div>
      )}
      <div className="pm-pcols mt-2 grid grid-cols-[1fr_1fr_0.9fr] gap-4">
        <Column title="Frontier" count={frontier.length} hint="unblocked · unclaimed" dot={<StatusDot state="outline" color="var(--bg-accent)" size={9} />}>
          {frontier.map((t) => (
            <Frontier key={t.id} t={t} />
          ))}
          {frontier.length === 0 && <div className={emptyInline}>Nothing on the frontier — resolve a blocker or pull a ticket in.</div>}
          {hitl.length >= 2 && (
            <div className="rounded-md border border-dashed border-strong px-2.5 py-2 text-caption text-secondary">
              Pacing: <strong>one judgment ticket per session</strong> — {hitl.map((t) => t.id).join(' and ')} all need you; don't batch them.
            </div>
          )}
        </Column>
        <Column title="Blocked" count={blocked.length} hint="behind the fog" dim dot={<StatusDot state="dashed" color="var(--gray-23)" size={9} />}>
          {blocked.map((t) => {
            const kind = ticketKind(t);
            return (
              <div key={t.id} className={cx(pcard, 'bg-card')} onClick={() => open(t.id)}>
                <div className={pcardTop}>
                  <span className={cardId} style={{ color: kindColor(kind) }}>{t.id}</span>
                  {kind && <span className={cardKind} style={{ color: kindColor(kind) }}>{kind}</span>}
                </div>
                <div className="text-subhead">{displayTitle(t)}</div>
                <div className={pcardFoot}>
                  <span className={hint}>waits on</span>
                  {unresolvedBlockers(t, index).map((b) => {
                    const c = kindColor(ticketKind(index.get(b)));
                    return (
                      <span key={b} className={waitChip} style={{ color: c, background: `${c}14` }}>
                        {b}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {blocked.length === 0 && <div className={emptyInline}>No blocked tickets.</div>}
        </Column>
        <Column title="Resolved" count={resolved.length} dim dot={<StatusDot state="solid" color="var(--bg-accent)" size={9} />}>
          {resolved.slice(0, 8).map((t) => {
            const last = (t.comments || []).at(-1);
            return (
              <div key={t.id} className={cx(pcard, 'bg-card-dim')} onClick={() => open(t.id)}>
                <div className={pcardTop}>
                  <span className={cardId} style={{ color: kindColor(ticketKind(t)) }}>{t.id}</span>
                  <span className={check}>✓</span>
                </div>
                <div className="text-item text-secondary">{displayTitle(t)}</div>
                {last && <div className="mt-1.5 text-note text-muted">→ {last.text.split('\n')[0].slice(0, 110)}</div>}
              </div>
            );
          })}
          {resolved.length > 8 && <div className="px-2.5 py-1 text-caption text-muted">+ {resolved.length - 8} more</div>}
          {resolved.length === 0 && <div className={emptyInline}>Nothing resolved yet.</div>}
        </Column>
      </div>
    </>
  );
}

function Column({
  title,
  count,
  hint,
  dot,
  dim,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  dot: React.ReactNode;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="pm-pcol min-w-0">
      <div className="flex items-center gap-2 px-0.5 pt-1 pb-2.5">
        {dot}
        <span className={cx('pm-pcol-title text-heading', dim && 'text-secondary')}>{title}</span>
        <span className={monoDim}>{count}</span>
        {hint && <span className="ml-auto text-caption text-muted">{hint}</span>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Frontier({ t }: { t: Item }) {
  const { open } = useBoardCtx();
  const kind = ticketKind(t);
  const color = kindColor(kind);
  const claim = t.assignee ? (
    <span className="font-mono text-tiny text-gold" title={`claimed ${t.assignedAt || ''}`}>
      ⚑ {t.assignee}
    </span>
  ) : isHitl(kind) ? (
    <span className={hint} style={{ color }}>needs a session</span>
  ) : (
    <span className={hint}>{t.stage}</span>
  );
  return (
    <div className={cx(pcard, 'bg-card')} style={{ borderColor: `${color}55` }} onClick={() => open(t.id)}>
      <div className={pcardTop}>
        <span className={cardId} style={{ color }}>{t.id}</span>
        {kind && <span className={cardKind} style={{ color }}>{kind}</span>}
        <span className={age}>{shortTime(t.updatedAt || t.createdAt)}</span>
      </div>
      <div className="text-subhead">{displayTitle(t)}</div>
      <div className={pcardFoot}>{claim}</div>
    </div>
  );
}
