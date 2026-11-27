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
import { shortTime } from '../time';
import { TicketsView } from './Lists';

const STRIP_CAP = 4;

/** A project: its destination and progress, then the map (frontier / blocked / resolved) or its kanban. */
export function ProjectView({ id, mode }: { id: string; mode: 'map' | 'board' }) {
  const { board, search, kinds, open } = useBoardCtx();
  const [expanded, setExpanded] = useState(false);
  const p = computeProjects(board).find((x) => x.id === id);
  if (!p) return <div className="pm-empty">Project not found — it may have been archived.</div>;
  const { resolved: done, total } = projectProgress(p);

  const strip = (
    <div className="pm-strip">
      <div className="pm-strip-text">
        <strong>Destination:</strong> {p.destination || '(no destination set)'}
      </div>
      <div className="pm-strip-progress">
        <ProgressBar value={done} max={Math.max(total, 1)} width={120} />
        <span className="pm-mono-dim">
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
      <button className="pm-exec pm-exec-more" onClick={() => setExpanded(true)}>
        + {n - STRIP_CAP} more {what}
      </button>
    ) : null;
  const index = byId(board.items);

  return (
    <>
      {strip}
      {designs.length > 0 && (
        <div className="pm-exec-strip">
          <span className="pm-exec-label">Documents</span>
          {cap(designs).map((d) => (
            <button key={d.id} className={`pm-exec${d.stage === 'done' ? ' pm-exec-done' : ''}`} onClick={() => open(d.id)}>
              <span className="pm-exec-id" style={{ color: DESIGN_COLOR }}>{d.id}</span>
              <span className="pm-exec-title">{displayTitle(d)}</span>
            </button>
          ))}
          {more(designs.length, 'docs')}
        </div>
      )}
      {plans.length > 0 && (
        <div className="pm-exec-strip">
          <span className="pm-exec-label">Execution</span>
          {cap(plans).map((pl) => {
            const prog = taskProgress(pl);
            return (
              <button key={pl.id} className={`pm-exec${pl.stage === 'done' ? ' pm-exec-done' : ''}`} onClick={() => open(pl.id)}>
                <span className="pm-exec-id">{pl.id}</span>
                <span className="pm-exec-title">{displayTitle(pl)}</span>
                <ProgressBar value={prog.done} max={Math.max(prog.total, 1)} width={40} height={3} color="var(--bg-green)" />
                <span className="pm-mono-dim">
                  {prog.done}/{prog.total}
                </span>
              </button>
            );
          })}
          {more(plans.length, 'plans')}
        </div>
      )}
      <div className="pm-pcols">
        <Column title="Frontier" count={frontier.length} hint="unblocked · unclaimed" dot={<StatusDot state="outline" color="var(--bg-accent)" size={9} />}>
          {frontier.map((t) => (
            <Frontier key={t.id} t={t} />
          ))}
          {frontier.length === 0 && <div className="pm-empty-inline">Nothing on the frontier — resolve a blocker or pull a ticket in.</div>}
          {hitl.length >= 2 && (
            <div className="pm-pacing">
              Pacing: <strong>one judgment ticket per session</strong> — {hitl.map((t) => t.id).join(' and ')} all need you; don't batch them.
            </div>
          )}
        </Column>
        <Column title="Blocked" count={blocked.length} hint="behind the fog" dim dot={<StatusDot state="dashed" color="var(--text-muted)" size={9} />}>
          {blocked.map((t) => {
            const kind = ticketKind(t);
            return (
              <div key={t.id} className="pm-pcard pm-pcard-blocked" onClick={() => open(t.id)}>
                <div className="pm-pcard-top">
                  <span className="pm-pcard-id" style={{ color: kindColor(kind) }}>{t.id}</span>
                  {kind && <span className="pm-pcard-kind" style={{ color: kindColor(kind) }}>{kind}</span>}
                </div>
                <div className="pm-pcard-title">{displayTitle(t)}</div>
                <div className="pm-pcard-foot">
                  <span className="pm-hint">waits on</span>
                  {unresolvedBlockers(t, index).map((b) => {
                    const c = kindColor(ticketKind(index.get(b)));
                    return (
                      <span key={b} className="pm-waitchip" style={{ color: c, background: `${c}14` }}>
                        {b}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {blocked.length === 0 && <div className="pm-empty-inline">No blocked tickets.</div>}
        </Column>
        <Column title="Resolved" count={resolved.length} dim narrow dot={<StatusDot state="solid" color="var(--bg-accent)" size={9} />}>
          {resolved.slice(0, 8).map((t) => {
            const last = (t.comments || []).at(-1);
            return (
              <div key={t.id} className="pm-pcard pm-pcard-resolved" onClick={() => open(t.id)}>
                <div className="pm-pcard-top">
                  <span className="pm-pcard-id" style={{ color: kindColor(ticketKind(t)) }}>{t.id}</span>
                  <span className="pm-check">✓</span>
                </div>
                <div className="pm-pcard-title">{displayTitle(t)}</div>
                {last && <div className="pm-outcome">→ {last.text.split('\n')[0].slice(0, 110)}</div>}
              </div>
            );
          })}
          {resolved.length > 8 && <div className="pm-more">+ {resolved.length - 8} more</div>}
          {resolved.length === 0 && <div className="pm-empty-inline">Nothing resolved yet.</div>}
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
  narrow,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  dot: React.ReactNode;
  dim?: boolean;
  narrow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`pm-pcol${narrow ? ' pm-pcol-narrow' : ''}`}>
      <div className="pm-pcol-head">
        {dot}
        <span className={`pm-pcol-title${dim ? ' pm-dim' : ''}`}>{title}</span>
        <span className="pm-column-count">{count}</span>
        {hint && <span className="pm-pcol-hint">{hint}</span>}
      </div>
      <div className="pm-pcol-cards">{children}</div>
    </section>
  );
}

function Frontier({ t }: { t: Item }) {
  const { open } = useBoardCtx();
  const kind = ticketKind(t);
  const color = kindColor(kind);
  const hint = t.assignee ? (
    <span className="pm-claim" title={`claimed ${t.assignedAt || ''}`}>
      ⚑ {t.assignee}
    </span>
  ) : isHitl(kind) ? (
    <span className="pm-hint" style={{ color }}>needs a session</span>
  ) : (
    <span className="pm-hint">{t.stage}</span>
  );
  return (
    <div className="pm-pcard pm-pcard-frontier" style={{ borderColor: `${color}55` }} onClick={() => open(t.id)}>
      <div className="pm-pcard-top">
        <span className="pm-pcard-id" style={{ color }}>{t.id}</span>
        {kind && <span className="pm-pcard-kind" style={{ color }}>{kind}</span>}
        <span className="pm-age">{shortTime(t.updatedAt || t.createdAt)}</span>
      </div>
      <div className="pm-pcard-title">{displayTitle(t)}</div>
      <div className="pm-pcard-foot">{hint}</div>
    </div>
  );
}
