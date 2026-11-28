import { useEffect, useState } from 'react';
import { ListRow, SectionLabel, StatusDot, TicketCard } from '@terjeballestad/bob';
import { api, type Design, type Item, type Plan } from '../api';
import { useBoardCtx } from '../BoardContext';
import { Markdown } from '../components/Markdown';
import { signpostHint } from '@shared/glossary.js';
import {
  byId,
  decisionGroups,
  DESIGN_COLOR,
  displayTitle,
  isTicket,
  kindColor,
  matchesSearch,
  nonFrontierTypes,
  PLAN_COLOR,
  taskProgress,
  ticketKind,
  unresolvedBlockers,
  type Board,
} from '../model';
import { age, cx, ddHead, ddId, empty, emptyInline, featured, featuredTitle, hoverRow, monoDim, plainButton, chip } from '../classes';
import { shortTime } from '../time';

const list = 'mx-auto flex max-w-[900px] flex-col';
const groupLabel = 'mt-5.5 mb-2 text-label text-muted uppercase';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={empty}>{children}</div>;
}

type Card = { type: 'item'; e: Item } | { type: 'design'; e: Design } | { type: 'plan'; e: Plan };

/** Which kanban column a record sits in, as 0.x's renderBoard decides it. */
function columnCards(b: Board, stage: string): Card[] {
  const out: Card[] = [];
  const items = (pred: (i: Item) => boolean) => b.items.filter(pred).forEach((e) => out.push({ type: 'item', e }));
  if (stage === 'done') {
    items((i) => i.stage === 'done' || i.stage === 'closed');
    b.designs.filter((d) => d.stage === 'done').forEach((e) => out.push({ type: 'design', e }));
    b.plans.filter((p) => p.stage === 'done').forEach((e) => out.push({ type: 'plan', e }));
  } else if (stage === 'sdd') {
    items((i) => i.stage === 'sdd');
    b.designs.filter((d) => d.stage !== 'done').forEach((e) => out.push({ type: 'design', e }));
  } else if (stage === 'planned') {
    items((i) => i.stage === 'planned');
    b.plans.filter((p) => p.stage !== 'done').forEach((e) => out.push({ type: 'plan', e }));
  } else {
    items((i) => i.stage === stage);
  }
  return out;
}

export function CardFor({ card }: { card: Card }) {
  const { board, open } = useBoardCtx();
  const comments = (card.e.comments || []).length;
  const commentNote = comments ? plural(comments, 'comment') : null;
  if (card.type === 'item') {
    const item = card.e;
    const kind = ticketKind(item);
    const blockers = unresolvedBlockers(item, byId(board.items));
    return (
      <TicketCard
        id={item.id}
        kind={kind ?? undefined}
        title={displayTitle(item)}
        age={shortTime(item.updatedAt || item.createdAt)}
        priority={item.priority || undefined}
        blocked={blockers.length ? `⊘ ${blockers.join(' · ')}` : undefined}
        note={commentNote}
        onClick={() => open(item.id)}
      />
    );
  }
  if (card.type === 'design') {
    const d = card.e;
    const linked = (d.linkedItems || d.itemIds || []).length;
    return (
      <TicketCard
        id={d.id}
        idColor={DESIGN_COLOR}
        label={{ text: 'map', color: DESIGN_COLOR }}
        emphasis="sdd"
        title={displayTitle(d)}
        age={shortTime(d.updatedAt || d.createdAt)}
        note={[commentNote, linked ? `${linked} linked` : null].filter(Boolean).join(' · ') || null}
        onClick={() => open(d.id)}
      />
    );
  }
  const p = card.e;
  const prog = taskProgress(p);
  return (
    <TicketCard
      id={p.id}
      idColor={PLAN_COLOR}
      label={{ text: 'plan', color: PLAN_COLOR }}
      emphasis="plan"
      title={displayTitle(p)}
      age={shortTime(p.updatedAt || p.createdAt)}
      note={commentNote}
      progress={prog.total ? prog : undefined}
      onClick={() => open(p.id)}
    />
  );
}

/** The stage kanban. With a project, only that project's records (and unassigned inbox tickets). */
export function TicketsView({ projectId }: { projectId?: string }) {
  const { board, search, kinds } = useBoardCtx();
  const offBoard = nonFrontierTypes(board.config);
  const stages = board.config.stages?.length ? board.config.stages : ['inbox', 'exploring', 'sdd', 'planned', 'done'];
  return (
    <div className="pm-kanban grid min-h-full auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3.5">
      {stages.map((stage) => {
        let cards = columnCards(board, stage).filter((c) => c.type !== 'item' || (c.e.type !== 'decision' && !offBoard.has(c.e.type)));
        if (projectId) cards = cards.filter((c) => c.e.sprintId === projectId || (stage === 'inbox' && !c.e.sprintId));
        cards = cards
          .filter((c) => matchesSearch(c.e, search))
          .filter((c) => c.type !== 'item' || kinds.size === 0 || kinds.has(ticketKind(c.e) ?? ''))
          .sort((a, b) => (b.e.createdAt || '').localeCompare(a.e.createdAt || ''));
        return (
          <section key={stage} className="pm-column flex min-w-0 flex-col">
            <div className="flex items-center gap-2 px-1 pt-1 pb-2.5">
              <StatusDot state={stage === 'inbox' ? 'dashed' : stage === 'done' ? 'solid' : 'outline'} color={stage === 'done' ? 'var(--bg-green)' : 'var(--gray-23)'} size={8} />
              <span className="pm-column-title text-heading">{stage.charAt(0).toUpperCase() + stage.slice(1)}</span>
              <span className={monoDim}>{cards.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {cards.map((c) => (
                <CardFor key={`${c.type}:${c.e.id}`} card={c} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function InboxView() {
  const { board, search, kinds, open } = useBoardCtx();
  const index = byId(board.items);
  const items = board.items
    .filter((i) => isTicket(i, board.config) && i.stage === 'inbox')
    .filter((i) => matchesSearch(i, search))
    .filter((i) => kinds.size === 0 || kinds.has(ticketKind(i) ?? ''))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!items.length) return <Empty>Inbox zero.</Empty>;
  return (
    <div className={list}>
      {items.map((t) => {
        const kind = ticketKind(t);
        const blockers = unresolvedBlockers(t, index);
        const last = (t.comments || []).at(-1);
        const meta = [
          kind && <span key="k" className="text-id" style={{ color: kindColor(kind) }}>{kind}</span>,
          t.priority && <span key="p" className="text-id text-orange">{t.priority.toUpperCase()}</span>,
          blockers.length > 0 && <span key="b" className="font-mono text-tiny text-orange">⊘ {blockers.join(' · ')}</span>,
          last && <span key="c">{last.author || ''} commented</span>,
        ].filter(Boolean);
        return (
          <ListRow
            key={t.id}
            id={t.id}
            idColor={kind ? kindColor(kind) : 'var(--text-muted)'}
            title={displayTitle(t)}
            meta={meta.length ? <span className="inline-flex items-center gap-2">{meta}</span> : undefined}
            age={shortTime(t.createdAt)}
            onClick={() => open(t.id)}
          />
        );
      })}
    </div>
  );
}

export function DocumentsView() {
  const { board, search, open } = useBoardCtx();
  const designs = board.designs.filter((d) => matchesSearch(d, search)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return (
    <div className={list}>
      <SectionLabel dot={<StatusDot state="solid" color={DESIGN_COLOR} size={7} square />} action={<span className={monoDim}>{designs.length}</span>}>
        Maps &amp; designs
      </SectionLabel>
      {designs.length === 0 && <div className={emptyInline}>No design documents.</div>}
      {designs.map((d) => {
        const linked = (d.linkedItems || d.itemIds || []).length;
        const done = d.stage === 'done';
        return (
          <ListRow
            key={d.id}
            id={d.id}
            idColor={DESIGN_COLOR}
            title={displayTitle(d)}
            meta={[linked ? `${linked} linked` : '', done ? 'done' : ''].filter(Boolean).join(' · ') || undefined}
            age={shortTime(d.updatedAt)}
            done={done}
            onClick={() => open(d.id)}
          />
        );
      })}
    </div>
  );
}

export function PlansView() {
  const { board, search, open } = useBoardCtx();
  const plans = board.plans.filter((p) => matchesSearch(p, search));
  if (!plans.length) return <Empty>No plans.</Empty>;
  const sprintName = (id?: string | null) => board.sprints.find((s) => s.id === id)?.name ?? null;
  const sorted = (xs: Plan[]) => [...xs].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const row = (p: Plan) => {
    const { done, total } = taskProgress(p);
    const meta = [total ? `${done}/${total} tasks` : '', sprintName(p.sprintId) ?? ''].filter(Boolean).join(' · ');
    return (
      <ListRow key={p.id} id={p.id} idColor={PLAN_COLOR} title={displayTitle(p)} meta={meta || undefined} age={shortTime(p.updatedAt)} done={p.stage === 'done'} onClick={() => open(p.id)} />
    );
  };
  const active = plans.filter((p) => p.stage !== 'done');
  const done = plans.filter((p) => p.stage === 'done');
  return (
    <div className={list}>
      <SectionLabel dot={<StatusDot state="solid" color={PLAN_COLOR} size={7} square />} action={<span className={monoDim}>{active.length}</span>}>
        In flight
      </SectionLabel>
      {active.length ? sorted(active).map(row) : <div className={emptyInline}>Nothing executing.</div>}
      {done.length > 0 && (
        <>
          <SectionLabel dot={<StatusDot state="solid" color="var(--gray-22)" size={7} square />} action={<span className={monoDim}>{done.length}</span>} className="mt-4.5">
            Done
          </SectionLabel>
          {sorted(done).map(row)}
        </>
      )}
    </div>
  );
}

export function DecisionsView() {
  const { board, search, open } = useBoardCtx();
  const q = search.toLowerCase();
  const decisions = board.items
    .filter((i) => i.type === 'decision')
    .filter((d) => !q || [d.title, d.id, d.body].some((s) => (s || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  if (!decisions.length) return <Empty>No decisions found.</Empty>;
  const groups = decisionGroups(decisions);
  const newest = groups.thisWeek[0];
  const row = (d: Item, faded: boolean) => (
    <button key={d.id} className={cx(plainButton, hoverRow, 'flex w-full items-baseline gap-3 px-1 py-1.5', faded && 'opacity-72')} onClick={() => open(d.id)}>
      <span className={ddId}>{d.id}</span>
      <span className="flex-1 text-base text-secondary">{displayTitle(d)}</span>
      <span className={age}>{shortTime(d.updatedAt || d.createdAt)}</span>
    </button>
  );
  return (
    <div className="mx-auto max-w-[820px]">
      {groups.thisWeek.length > 0 && <div className={groupLabel}>This week</div>}
      {groups.thisWeek.map((d) =>
        d === newest ? (
          <div key={d.id} className={featured} onClick={() => open(d.id)}>
            <div className={ddHead}>
              <span className={ddId}>{d.id}</span>
              <span className={featuredTitle}>{displayTitle(d)}</span>
              <span className={age}>{shortTime(d.updatedAt || d.createdAt)}</span>
            </div>
            {d.body && <Markdown text={d.body.split('\n\n').slice(0, 2).join('\n\n')} />}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(d.related || []).map((r) => (
                <button key={r} className={chip} onClick={(e) => (e.stopPropagation(), open(r))}>
                  {r}
                </button>
              ))}
              {(d.comments || []).length > 0 && <span className={chip}>{plural((d.comments || []).length, 'refinement')} in thread</span>}
            </div>
          </div>
        ) : (
          row(d, false)
        ),
      )}
      {groups.lastWeek.length > 0 && <div className={groupLabel}>Last week</div>}
      {groups.lastWeek.map((d) => row(d, false))}
      {groups.older.map(([month, ds]) => (
        <div key={month}>
          <div className={cx(groupLabel, 'opacity-72')}>{month} · fading by design</div>
          {ds.map((d) => row(d, true))}
        </div>
      ))}
    </div>
  );
}

export function GlossaryView() {
  const { board, search, open, terms } = useBoardCtx();
  const q = search.toLowerCase();
  const list = board.items
    .filter((i) => i.type === 'term')
    .filter((t) => !q || [t.title, t.id, t.body, ...(t.aliases || [])].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  if (!list.length) {
    return search ? (
      <Empty>No terms match.</Empty>
    ) : (
      <Empty>
        No terms yet — one word, one meaning.
        <br />
        <code>pm create term "the-word" --body "One sentence."</code>
      </Empty>
    );
  }
  const titleById = new Map(board.items.map((i) => [i.id, i.title || i.id]));
  return (
    <div className="mx-auto max-w-[900px]">
      {list.map((t) => {
        const signpost = terms?.terms.get(t.id)?.kind === 'signpost';
        return (
          <div key={t.id} className={cx(featured, signpost && 'border-l-3 border-l-yellow-9')} onClick={() => open(t.id)}>
            <div className={ddHead}>
              <span className={ddId}>{t.id}</span>
              <span className={featuredTitle}>{t.title}</span>
              {(t.aliases || []).length > 0 && <span className={chip}>also: {(t.aliases || []).join(', ')}</span>}
            </div>
            {signpost ? (
              <span className="text-base text-yellow">{signpostHint((t.related || []).map((r) => titleById.get(r) || r))}</span>
            ) : t.body ? (
              <Markdown text={t.body} />
            ) : (
              // BOB GAP: Bob has no italic style. `italic` is the one type class here next to a style.
              <span className="text-base text-muted italic">No definition yet</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ArchiveView() {
  const { board, search } = useBoardCtx();
  const [archived, setArchived] = useState<Item[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api.archived(board.slug, ctrl.signal).then(setArchived, () => setArchived([]));
    return () => ctrl.abort();
  }, [board.slug, board.items]);
  if (archived === null) return <Empty>Loading archive…</Empty>;
  const rows = archived.filter((a) => matchesSearch(a, search)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (!rows.length) return <Empty>Archive is empty.</Empty>;
  return (
    <div className={list}>
      {rows.map((t) => {
        const kind = ticketKind(t);
        return (
          <div key={t.id}>
            <ListRow id={t.id} idColor={kind ? kindColor(kind) : 'var(--text-faint)'} title={displayTitle(t)} age={shortTime(t.updatedAt)} done onClick={() => setExpanded(expanded === t.id ? null : t.id)} />
            {expanded === t.id && (
              <div className="pt-1.5 pr-3 pb-3.5 pl-15">
                <Markdown text={t.body || '(no description)'} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
