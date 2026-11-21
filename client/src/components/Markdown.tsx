import { useMemo, type MouseEvent } from 'react';
import { useBoardCtx } from '../BoardContext';
import { mdToHtml } from '../markdown';

/**
 * A markdown body, rendered by the 0.x renderer (see markdown.ts for why its HTML is safe). A click
 * on a key (SB-042) or a glossary term opens that record.
 */
export function Markdown({ text, className = 'md' }: { text?: string | null; className?: string }) {
  const { terms, open } = useBoardCtx();
  const html = useMemo(() => mdToHtml(text, terms), [text, terms]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ref-id], [data-term-id]');
    if (!el) return;
    e.stopPropagation();
    open(el.dataset.refId || el.dataset.termId || '');
  };
  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
