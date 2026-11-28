import { useEffect, useState } from 'react';
import { ListRow, SectionLabel } from '@terjeballestad/bob';
import { api, type BoardSummary } from './api';
import { BoardProvider } from './BoardContext';
import { Detail } from './components/Detail';
import { Rail, Sidebar, Topbar, VIEWS, type ViewName } from './components/Frame';
import { QuickOpen } from './components/QuickOpen';
import { navigate, useLocation } from './router';
import { emptyInline, monoDim } from './classes';
import { notify } from './toast';
import { useBoard, useTermIndex } from './useBoard';
import { ProjectView } from './views/Project';
import { ArchiveView, DecisionsView, DocumentsView, GlossaryView, InboxView, PlansView, TicketsView } from './views/Lists';

const home = 'mx-auto my-15 max-w-[720px] px-4';
const error_ = 'p-10 text-danger';

const VIEW_NAMES = new Set<string>(VIEWS.map((v) => v.view));

/**
 * Routes: /                         every board
 *         /<board>/<view>           tickets, inbox, documents, plans, decisions, glossary, archive
 *         /<board>/project/<id>     a project, ?mode=board for its kanban
 *         ...?open=<key>            a record's detail panel over any of these
 */
export function App() {
  const { path, params } = useLocation();
  const [slug, a, b] = path.split('/').filter(Boolean);
  useEffect(() => {
    // An unknown view: fall back to the board's tickets, keeping the slug.
    if (slug && a && a !== 'project' && !VIEW_NAMES.has(a)) navigate(`/${slug}/tickets`, { replace: true });
  }, [slug, a]);
  if (!slug) return <BoardList />;
  let view: ViewName = 'tickets';
  let projectId: string | undefined;
  if (a === 'project' && b) {
    view = 'project';
    projectId = b;
  } else if (a && VIEW_NAMES.has(a)) {
    view = a as ViewName;
  }
  return (
    <BoardPage
      slug={decodeURIComponent(slug)}
      view={view}
      projectId={projectId}
      mode={params.get('mode') === 'board' ? 'board' : 'map'}
      openId={params.get('open')}
    />
  );
}

function BoardList() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.title = 'pm';
    api.boards().then(setBoards, (e: Error) => setError(e.message));
  }, []);
  return (
    <div className={home}>
      <h1 className="mb-6 text-display">pm</h1>
      <SectionLabel action={boards ? <span className={monoDim}>{boards.length}</span> : undefined}>Boards</SectionLabel>
      {error && <div className={error_}>Could not load the boards: {error}</div>}
      {boards?.length === 0 && <div className={emptyInline}>No boards yet. Import one with PmBoard.Api import.</div>}
      {boards?.map((b) => <ListRow key={b.slug} id={b.slug} title={b.name} onClick={() => navigate(`/${b.slug}/tickets`)} />)}
    </div>
  );
}

function BoardPage({
  slug,
  view,
  projectId,
  mode,
  openId,
}: {
  slug: string;
  view: ViewName;
  projectId?: string;
  mode: 'map' | 'board';
  openId: string | null;
}) {
  const state = useBoard(slug);
  const terms = useTermIndex(state.status === 'ready' ? state.board.items : undefined);
  const [quickOpen, setQuickOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (state.status === 'ready') document.title = `${state.board.config.name || slug} · pm`;
  }, [state, slug]);

  if (state.status === 'loading') return <div className="p-10 text-muted">Loading {slug}…</div>;
  if (state.status === 'missing')
    return (
      <div className={home}>
        <div className={error_}>There is no board called “{slug}”.</div>
        <ListRow id="←" title="All boards" onClick={() => navigate('/')} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className={home}>
        <div className={error_}>
          Could not load {slug}: {state.message}
        </div>
      </div>
    );

  const main = (() => {
    switch (view) {
      case 'project':
        return <ProjectView id={projectId!} mode={mode} />;
      case 'inbox':
        return <InboxView />;
      case 'documents':
        return <DocumentsView />;
      case 'plans':
        return <PlansView />;
      case 'decisions':
        return <DecisionsView />;
      case 'glossary':
        return <GlossaryView />;
      case 'archive':
        return <ArchiveView />;
      default:
        return <TicketsView />;
    }
  })();
  const withRail = view !== 'decisions' && view !== 'documents';

  return (
    <BoardProvider board={state.board} terms={terms} live={state.live} toast={notify}>
      <div className={`pm-app${withRail ? '' : ' pm-no-rail'}`}>
        <Sidebar view={view} projectId={projectId} onQuickOpen={() => setQuickOpen(true)} />
        <main className="flex min-h-0 min-w-0 flex-col">
          <Topbar view={view} projectId={projectId} mode={mode} />
          <div className="pm-content flex-1 overflow-auto px-4 pt-4.5 pb-10">{main}</div>
        </main>
        {withRail && <Rail />}
      </div>
      {openId && <Detail id={openId} />}
      {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} />}
    </BoardProvider>
  );
}
