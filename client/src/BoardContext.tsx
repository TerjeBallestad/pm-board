import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { TermIndex } from '@shared/glossary.js';
import type { Board } from './model';
import { navigate, withOpen } from './router';

interface BoardCtx {
  board: Board;
  terms: TermIndex | null;
  live: boolean;
  /** Open a record's detail panel by its key (?open=KEY). */
  open: (id: string) => void;
  close: () => void;
  /** The search filter in the top bar. */
  search: string;
  setSearch: (q: string) => void;
  /** Kind filters from the sidebar. */
  kinds: ReadonlySet<string>;
  toggleKind: (k: string) => void;
  toast: (text: string, error?: boolean) => void;
}

const Ctx = createContext<BoardCtx | null>(null);

export function BoardProvider({
  board,
  terms,
  live,
  toast,
  children,
}: {
  board: Board;
  terms: TermIndex | null;
  live: boolean;
  toast: (text: string, error?: boolean) => void;
  children: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<string>>(new Set());
  const open = useCallback((id: string) => navigate(withOpen(id)), []);
  const close = useCallback(() => navigate(withOpen(null)), []);
  const toggleKind = useCallback(
    (k: string) =>
      setKinds((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      }),
    [],
  );
  const value = useMemo(
    () => ({ board, terms, live, open, close, search, setSearch, kinds, toggleKind, toast }),
    [board, terms, live, open, close, search, kinds, toggleKind, toast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBoardCtx(): BoardCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBoardCtx outside BoardProvider');
  return c;
}
