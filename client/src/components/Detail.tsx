import { useEffect, useState } from 'react';
import { Avatar, Button, Chip, SectionLabel } from '@terjeballestad/bob';
import type { Comment, Design, Item, Plan, Sprint, TestEntry } from '../api';
import { useBoardCtx } from '../BoardContext';
import {
  authorAvatar,
  byId,
  computeProjects,
  DECISION_COLOR,
  DESIGN_COLOR,
  displayTitle,
  findEntity,
  isResolvedStage,
  kindColor,
  NEUTRAL,
  PLAN_COLOR,
  projectProgress,
  splitByFrontier,
  startCommand,
  ticketKind,
  unresolvedBlockers,
  type EntityKind,
} from '../model';
import { relativeTime } from '../time';
import { Markdown } from './Markdown';

/** The right slide-over for ?open=KEY. Read-only in 1.x until the write API exists. */
export function Detail({ id }: { id: string }) {
  const { board, close } = useBoardCtx();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const found = findEntity(board, id);
  return (
    <div className="pm-overlay" onClick={close}>
      <div className="pm-slide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={id}>
        {!found ? (
          <>
            <Header id={id} color={NEUTRAL} chip="Not found" />
            <div className="pm-slide-body">
              <p className="pm-dimtext">No record {id} on this board. It may be archived, or the key may be wrong.</p>
            </div>
          </>
        ) : found.kind === 'item' ? (
          <ItemDetail item={found.entity as Item} />
        ) : found.kind === 'design' ? (
          <DesignDetail d={found.entity as Design} />
        ) : found.kind === 'plan' ? (
          <PlanDetail p={found.entity as Plan} />
        ) : (
          <SprintDetail s={found.entity as Sprint} />
        )}
      </div>
    </div>
  );
}

function Header({
  id,
  color,
  chip,
  sub,
  start,
}: {
  id: string;
  color: string;
  chip: string;
  sub?: string;
  start?: { entity: { id: string; title?: string; name?: string }; kind: EntityKind };
}) {
  const { board, close, toast } = useBoardCtx();
  const cmd = start ? startCommand(board.config, start.entity, start.kind) : null;
  const copy = async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast(`Copied: ${cmd}`);
    } catch {
      toast('Could not copy to the clipboard', true);
    }
  };
  return (
    <div className="pm-slide-header">
      <span className="pm-slide-id" style={{ color }}>{id}</span>
      <span className="pm-typechip" style={{ color, background: `${color}1f` }}>{chip}</span>
      {sub && <span className="pm-dimtext">{sub}</span>}
      <div className="pm-slide-actions">
        {cmd && (
          <Button size="sm" variant="primary" onClick={copy} title={cmd}>
            ⧉ Start
          </Button>
        )}
        <button className="pm-close" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  );
}

function Meta({ items }: { items: [string, string | null | undefined][] }) {
  return (
    <div className="pm-meta-row">
      {items.map(([label, value]) => (
        <span key={label} className="pm-meta-item">
          <span>{label}</span>
          <strong>{value || '--'}</strong>
        </span>
      ))}
    </div>
  );
}

function RefChips({ label, ids, done }: { label: string; ids: string[]; done?: (id: string) => boolean }) {
  const { open, board } = useBoardCtx();
  if (!ids.length) return null;
  const index = byId(board.items);
  return (
    <div className="pm-chips-row">
      <span className="pm-chips-label">{label}</span>
      {ids.map((rid) => {
        const isDone = done?.(rid) ?? false;
        const c = kindColor(ticketKind(index.get(rid)));
        return (
          <button key={rid} className="pm-waitchip" style={{ color: isDone ? 'var(--text-muted)' : c, background: isDone ? 'transparent' : `${c}14` }} onClick={() => open(rid)}>
            {rid}
            {isDone ? ' ✓' : ''}
          </button>
        );
      })}
    </div>
  );
}

function Thread({ comments }: { comments: Comment[] }) {
  return (
    <div className="pm-thread">
      <SectionLabel>Thread{comments.length ? ` · ${comments.length}` : ''}</SectionLabel>
      {comments.length === 0 && <div className="pm-empty-inline">No messages yet.</div>}
      {comments.map((c, i) => {
        const av = authorAvatar(c.author);
        return (
          <div key={c.id || i} className="pm-comment">
            <Avatar initials={av.initial} tone={av.tone} size={20} />
            <div className="pm-comment-main">
              <div className="pm-comment-head">
                <span className="pm-comment-author">{c.author || 'Unknown'}</span>
                <span className="pm-dimtext">{relativeTime(c.createdAt)}</span>
              </div>
              <Markdown text={c.text} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Tests({ tests }: { tests?: TestEntry[] }) {
  const list = Array.isArray(tests) ? tests : [];
  return (
    <div className="pm-section">
      <SectionLabel>Verified claims</SectionLabel>
      {list.length === 0 && <div className="pm-empty-inline">(no claims yet — no tests guard this decision)</div>}
      {list.map((t, i) => (
        <div key={i} className="pm-test">
          <div className="pm-test-head">
            <span className="pm-test-name">{t.name}</span>
            {t.file && <span className="pm-mono-dim">{t.file}</span>}
          </div>
          {(t.claims || []).length > 0 && (
            <ul className="pm-test-claims">
              {(t.claims || []).map((c, j) => (
                <li key={j}>{c.text || c.method}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function ItemDetail({ item }: { item: Item }) {
  const { board } = useBoardCtx();
  const kind = ticketKind(item);
  const isDecision = item.type === 'decision';
  const typeMeta = Object.values(board.config.entityTypes || {}).find((m) => m && String(m.label || '').toLowerCase() === item.type);
  const color = isDecision ? DECISION_COLOR : kind ? kindColor(kind) : typeMeta?.color || NEUTRAL;
  const chip = isDecision ? 'Decision' : kind || typeMeta?.label || item.type || 'ticket';
  const index = byId(board.items);
  const sprint = board.sprints.find((s) => s.id === item.sprintId);
  return (
    <>
      <Header id={item.id} color={color} chip={chip} sub={`updated ${relativeTime(item.updatedAt)}`} start={{ entity: item, kind: 'item' }} />
      <div className="pm-slide-body">
        <h1 className="pm-doc-title">{item.title}</h1>
        <Meta items={[['Stage', item.stage], ['Priority', item.priority], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null]]} />
        {item.assignee && (
          <div className="pm-chips-row">
            <span className="pm-chips-label">claimed</span>
            <Chip mono tone="claim">
              ⚑ {item.assignee}
            </Chip>
            <span className="pm-dimtext">{relativeTime(item.assignedAt)}</span>
          </div>
        )}
        <RefChips label="waits on" ids={item.blockedBy || []} done={(b) => !index.get(b) || isResolvedStage(index.get(b)!.stage)} />
        <RefChips label="related" ids={item.related || []} />
        {item.body ? <Markdown text={item.body} /> : <p className="pm-dimtext">No description</p>}
        {isDecision && <Tests tests={item.tests} />}
        {(item.affectedFiles || []).length > 0 && (
          <div className="pm-section">
            <SectionLabel>Affected files</SectionLabel>
            <ul className="pm-files">
              {(item.affectedFiles || []).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        <Thread comments={item.comments || []} />
      </div>
    </>
  );
}

function DesignDetail({ d }: { d: Design }) {
  const { board, open } = useBoardCtx();
  const index = byId(board.items);
  const linked = (d.linkedItems || d.itemIds || []).map((x) => index.get(x)).filter((x): x is Item => !!x);
  const frontier = new Set(splitByFrontier(linked, board.items).frontier.map((t) => t.id));
  const resolved = linked.filter((t) => isResolvedStage(t.stage)).length;
  const sprint = board.sprints.find((s) => s.id === d.sprintId);
  return (
    <>
      <Header id={d.id} color={DESIGN_COLOR} chip="Map" sub={`updated ${relativeTime(d.updatedAt)}`} start={{ entity: d, kind: 'design' }} />
      <div className="pm-slide-body">
        <h1 className="pm-doc-title">{d.title}</h1>
        <Meta items={[['Stage', d.stage], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null]]} />
        {linked.length > 0 && (
          <>
            <SectionLabel action={<span className="pm-count">{linked.length} · {resolved} resolved</span>}>Tickets</SectionLabel>
            <div className="pm-map-tickets">
              {linked.map((t) => {
                const kind = ticketKind(t);
                const c = kindColor(kind);
                const done = isResolvedStage(t.stage);
                const hot = frontier.has(t.id);
                const blockers = unresolvedBlockers(t, index);
                return (
                  <button key={t.id} className={`pm-mt-row${done ? ' pm-mt-done' : ''}`} style={hot ? { background: `${c}0a` } : undefined} onClick={() => open(t.id)}>
                    {done ? <span className="pm-check">✓</span> : <span className={`pm-ring${hot ? '' : ' pm-ring-fog'}`} style={hot ? { borderColor: c } : undefined} />}
                    <span className="pm-pcard-id" style={{ color: c }}>{t.id}</span>
                    <span className="pm-mt-title">{displayTitle(t)}</span>
                    {!done && hot && <span className="pm-frontier-tag" style={{ color: c }}>FRONTIER</span>}
                    {!done && !hot && blockers.length > 0 && <span className="pm-mono-dim">⊘ {blockers.map((b) => b.replace(/^[A-Z]+-/, '')).join(' · ')}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {d.body ? <Markdown text={d.body} /> : <p className="pm-dimtext">No description</p>}
        <Tests tests={d.tests} />
        <Thread comments={d.comments || []} />
      </div>
    </>
  );
}

function PlanDetail({ p }: { p: Plan }) {
  const { board } = useBoardCtx();
  const [openTask, setOpenTask] = useState<string | null>(null);
  const ctx = typeof p.context === 'object' && p.context ? p.context : {};
  const tasks = p.tasks || [];
  const done = tasks.filter((t) => t.status === 'done').length;
  const sprint = board.sprints.find((s) => s.id === p.sprintId);
  const dd = Array.isArray(ctx.designDecisions) ? ctx.designDecisions.map((x) => `- ${x}`).join('\n') : ctx.designDecisions;
  return (
    <>
      <Header id={p.id} color={PLAN_COLOR} chip="Plan" sub={`updated ${relativeTime(p.updatedAt)}`} start={{ entity: p, kind: 'plan' }} />
      <div className="pm-slide-body">
        <h1 className="pm-doc-title">{displayTitle(p)}</h1>
        <Meta items={[['Stage', p.stage], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null], ['Tasks', `${done}/${tasks.length} done`]]} />
        {(ctx.setupNotes || ctx.relevantFiles || dd) && (
          <details className="pm-context">
            <summary>Context</summary>
            {ctx.setupNotes && <Markdown text={ctx.setupNotes} />}
            {(ctx.relevantFiles || []).length > 0 && (
              <>
                <strong>Relevant files</strong>
                <ul className="pm-files">
                  {(ctx.relevantFiles || []).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            )}
            {dd && (
              <>
                <strong>Design decisions</strong>
                <Markdown text={dd} />
              </>
            )}
          </details>
        )}
        <SectionLabel>Tasks</SectionLabel>
        {tasks.length === 0 && <div className="pm-empty-inline">No tasks</div>}
        {tasks.map((t, i) => {
          const key = t.id || String(i);
          const isOpen = openTask === key;
          const steps = Array.isArray(t.steps) ? t.steps.map((s, j) => `${j + 1}. ${s}`).join('\n') : t.steps;
          return (
            <div key={key} className="pm-task">
              <button className="pm-task-head" onClick={() => setOpenTask(isOpen ? null : key)}>
                <span className={`pm-task-box${t.passes ? ' pm-task-pass' : ''}`}>{t.passes ? '✓' : ''}</span>
                <span className="pm-task-title">{t.title || `Task ${i + 1}`}</span>
                <span className={`pm-task-status pm-status-${t.status || 'pending'}`}>{t.status || 'pending'}</span>
                {(t.blockedBy || []).length > 0 && <span className="pm-mono-dim">⊘ {(t.blockedBy || []).join(', ')}</span>}
              </button>
              {isOpen && (
                <div className="pm-task-details">
                  {t.id && <div className="pm-mono-dim">{t.id}</div>}
                  {t.description && <Markdown text={t.description} />}
                  {steps && <Markdown text={steps} />}
                  {t.verification && (
                    <div className="pm-task-verification">
                      <strong>Verification</strong>
                      <pre>{t.verification}</pre>
                    </div>
                  )}
                  {(t.progressNotes || []).length > 0 && (
                    <div className="pm-task-notes">
                      <strong>Progress</strong>
                      {(t.progressNotes || []).map((n, j) => (
                        <div key={j} className="pm-task-note">
                          <Markdown text={n.text} />
                          {n.timestamp && <span className="pm-dimtext">{new Date(n.timestamp).toLocaleString()}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <Thread comments={p.comments || []} />
      </div>
    </>
  );
}

function SprintDetail({ s }: { s: Sprint }) {
  const { board } = useBoardCtx();
  const p = computeProjects(board).find((x) => x.id === s.id);
  const prog = p ? projectProgress(p) : { resolved: 0, total: 0 };
  return (
    <>
      <Header
        id={s.id}
        color={DESIGN_COLOR}
        chip="Project"
        sub={`${prog.resolved}/${prog.total} resolved${s.status === 'completed' ? ' · completed' : ''}`}
        start={{ entity: s, kind: 'sprint' }}
      />
      <div className="pm-slide-body">
        <h1 className="pm-doc-title">{s.name || s.id}</h1>
        {s.problemStatement && (
          <blockquote className="pm-destination">
            <strong>Destination:</strong> {s.problemStatement}
          </blockquote>
        )}
        {s.body ? <Markdown text={s.body} /> : <p className="pm-dimtext">No project doc yet — decisions log and out-of-scope live here.</p>}
        <Thread comments={s.comments || []} />
      </div>
    </>
  );
}
