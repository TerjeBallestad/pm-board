import { useEffect, useState } from 'react';
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
import { Avatar, Button, Chip, SectionLabel, StatusDot } from '@terjeballestad/bob';
import { cardId, check, cx, dimText, emptyInline, files, hoverRow, monoDim, plainButton, section, waitChip } from '../classes';
import { relativeTime } from '../time';
import { Markdown } from './Markdown';

const slideBody = 'pm-slide-body flex-1 overflow-y-auto px-8 pt-5.5 pb-10';
const docTitle = 'mb-3.5 text-display';
const chipsRow = 'mb-3 flex flex-wrap items-center gap-1.5';
const chipsLabel = 'mr-0.5 text-caption text-muted';
/** A task's status chip: its colours. */
const TASK_STATUS: Record<string, string> = {
  pending: 'bg-input text-secondary',
  done: 'bg-green-tint text-green',
  in_progress: 'bg-orange-tint text-orange',
};

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
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim" onClick={close}>
      <div className="pm-slide flex h-full w-[min(780px,100vw)] flex-col border-l border-strong bg-sidebar shadow-overlay" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={id}>
        {!found ? (
          <>
            <Header id={id} color={NEUTRAL} chip="Not found" />
            <div className={slideBody}>
              <p className={dimText}>No record {id} on this board. It may be archived, or the key may be wrong.</p>
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
    <div className="flex flex-wrap items-center gap-2.5 border-b border-subtle px-6 py-3.25">
      <span className="font-mono text-subhead" style={{ color }}>{id}</span>
      <span className="rounded-chip px-2 py-0.5 text-id" style={{ color, background: `${color}1f` }}>{chip}</span>
      {sub && <span className={dimText}>{sub}</span>}
      <div className="ml-auto flex items-center gap-1.5">
        {cmd && (
          <Button size="sm" variant="primary" onClick={copy} title={cmd}>
            ⧉ Start
          </Button>
        )}
        <button className="modal-close px-1" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  );
}

function Meta({ items }: { items: [string, string | null | undefined][] }) {
  return (
    <div className="pm-meta-row mb-3.5 flex flex-wrap gap-2">
      {items.map(([label, value]) => (
        <span key={label} className="inline-flex items-center gap-2 rounded-md border border-strong bg-input px-2.5 py-1 text-body">
          <span className="text-muted">{label}</span>
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
    <div className={chipsRow}>
      <span className={chipsLabel}>{label}</span>
      {ids.map((rid) => {
        const isDone = done?.(rid) ?? false;
        const c = kindColor(ticketKind(index.get(rid)));
        return (
          <button key={rid} className={waitChip} style={{ color: isDone ? 'var(--text-muted)' : c, background: isDone ? 'transparent' : `${c}14` }} onClick={() => open(rid)}>
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
    <div className="mt-6.5 border-t border-subtle pt-4">
      <SectionLabel>Thread{comments.length ? ` · ${comments.length}` : ''}</SectionLabel>
      {comments.length === 0 && <div className={emptyInline}>No messages yet.</div>}
      {comments.map((c, i) => {
        const av = authorAvatar(c.author);
        return (
          <div key={c.id || i} className="flex gap-2.5 py-2.5">
            <Avatar initials={av.initial} tone={av.tone} size={20} />
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-baseline gap-2.5">
                <span className="text-subhead">{c.author || 'Unknown'}</span>
                <span className={dimText}>{relativeTime(c.createdAt)}</span>
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
    <div className={section}>
      <SectionLabel>Verified claims</SectionLabel>
      {list.length === 0 && <div className={emptyInline}>(no claims yet — no tests guard this decision)</div>}
      {list.map((t, i) => (
        <div key={i} className="mt-1.5 rounded-md border border-subtle px-2.5 py-2">
          <div className="flex items-baseline gap-2.5">
            <span className="text-subhead">{t.name}</span>
            {t.file && <span className={monoDim}>{t.file}</span>}
          </div>
          {(t.claims || []).length > 0 && (
            <ul className="mt-1.5 pl-4.5 text-body text-secondary">
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
      <div className={slideBody}>
        <h1 className={docTitle}>{item.title}</h1>
        <Meta items={[['Stage', item.stage], ['Priority', item.priority], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null]]} />
        {item.assignee && (
          <div className={chipsRow}>
            <span className={chipsLabel}>claimed</span>
            <Chip mono tone="claim">
              ⚑ {item.assignee}
            </Chip>
            <span className={dimText}>{relativeTime(item.assignedAt)}</span>
          </div>
        )}
        <RefChips label="waits on" ids={item.blockedBy || []} done={(b) => !index.get(b) || isResolvedStage(index.get(b)!.stage)} />
        <RefChips label="related" ids={item.related || []} />
        {item.body ? <Markdown text={item.body} /> : <p className={dimText}>No description</p>}
        {isDecision && <Tests tests={item.tests} />}
        {(item.affectedFiles || []).length > 0 && (
          <div className={section}>
            <SectionLabel>Affected files</SectionLabel>
            <ul className={files}>
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
      <div className={slideBody}>
        <h1 className={docTitle}>{d.title}</h1>
        <Meta items={[['Stage', d.stage], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null]]} />
        {linked.length > 0 && (
          <>
            <SectionLabel action={<span className={monoDim}>{linked.length} · {resolved} resolved</span>}>Tickets</SectionLabel>
            <div className="mt-1.5 mb-4.5 flex flex-col">
              {linked.map((t) => {
                const kind = ticketKind(t);
                const c = kindColor(kind);
                const done = isResolvedStage(t.stage);
                const hot = frontier.has(t.id);
                const blockers = unresolvedBlockers(t, index);
                return (
                  <button
                    key={t.id}
                    className={cx(plainButton, hoverRow, 'flex items-center gap-2.5 px-2 py-1.5', done && 'opacity-60')}
                    style={hot ? { background: `${c}0a` } : undefined}
                    onClick={() => open(t.id)}
                  >
                    {done ? <span className={check}>✓</span> : <StatusDot state={hot ? 'outline' : 'dashed'} color={c} size={9} />}
                    <span className={cardId} style={{ color: c }}>{t.id}</span>
                    <span className="min-w-0 flex-1 text-body">{displayTitle(t)}</span>
                    {!done && hot && <span className="text-micro uppercase" style={{ color: c }}>FRONTIER</span>}
                    {!done && !hot && blockers.length > 0 && <span className={monoDim}>⊘ {blockers.map((b) => b.replace(/^[A-Z]+-/, '')).join(' · ')}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {d.body ? <Markdown text={d.body} /> : <p className={dimText}>No description</p>}
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
      <div className={slideBody}>
        <h1 className={docTitle}>{displayTitle(p)}</h1>
        <Meta items={[['Stage', p.stage], ['Project', sprint ? `${sprint.id} — ${sprint.name}` : null], ['Tasks', `${done}/${tasks.length} done`]]} />
        {(ctx.setupNotes || ctx.relevantFiles || dd) && (
          <details className="mb-4 rounded-md border border-subtle px-3 py-2">
            <summary className="cursor-pointer text-subhead">Context</summary>
            {ctx.setupNotes && <Markdown text={ctx.setupNotes} />}
            {(ctx.relevantFiles || []).length > 0 && (
              <>
                <strong>Relevant files</strong>
                <ul className={files}>
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
        {tasks.length === 0 && <div className={emptyInline}>No tasks</div>}
        {tasks.map((t, i) => {
          const key = t.id || String(i);
          const isOpen = openTask === key;
          const steps = Array.isArray(t.steps) ? t.steps.map((s, j) => `${j + 1}. ${s}`).join('\n') : t.steps;
          return (
            <div key={key} className="border-b border-subtle">
              <button className={cx(plainButton, 'flex w-full items-center gap-2.5 px-0.5 py-2.25')} onClick={() => setOpenTask(isOpen ? null : key)}>
                <span
                  className={cx(
                    'pm-task-box inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    t.passes ? 'border-green-9 bg-green-tint text-green' : 'border-strong',
                  )}
                >
                  {t.passes ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 text-body">{t.title || `Task ${i + 1}`}</span>
                <span className={cx('shrink-0 rounded-kbd px-1.5 py-px font-mono text-tiny', TASK_STATUS[t.status || 'pending'] ?? TASK_STATUS.pending)}>{t.status || 'pending'}</span>
                {(t.blockedBy || []).length > 0 && <span className={monoDim}>⊘ {(t.blockedBy || []).join(', ')}</span>}
              </button>
              {isOpen && (
                <div className="pt-1 pr-1 pb-3.5 pl-6.5 text-body">
                  {t.id && <div className={monoDim}>{t.id}</div>}
                  {t.description && <Markdown text={t.description} />}
                  {steps && <Markdown text={steps} />}
                  {t.verification && (
                    <div>
                      <strong>Verification</strong>
                      <pre className="rounded-md bg-input px-2.5 py-2 font-mono text-caption whitespace-pre-wrap text-secondary">{t.verification}</pre>
                    </div>
                  )}
                  {(t.progressNotes || []).length > 0 && (
                    <div>
                      <strong>Progress</strong>
                      {(t.progressNotes || []).map((n, j) => (
                        <div key={j} className="my-1.5 border-l-2 border-strong pl-2.5">
                          <Markdown text={n.text} />
                          {n.timestamp && <span className={dimText}>{new Date(n.timestamp).toLocaleString()}</span>}
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
      <div className={slideBody}>
        <h1 className={docTitle}>{s.name || s.id}</h1>
        {s.problemStatement && (
          <blockquote className="mb-4 rounded-r-md border-l-3 border-l-indigo-9 bg-accent-tint px-3.5 py-2.5 text-base">
            <strong>Destination:</strong> {s.problemStatement}
          </blockquote>
        )}
        {s.body ? <Markdown text={s.body} /> : <p className={dimText}>No project doc yet — decisions log and out-of-scope live here.</p>}
        <Thread comments={s.comments || []} />
      </div>
    </>
  );
}
