// 0.x's mdToHtml, ported as it was, so a body renders the same in 1.x: entity keys become clickable
// refs, and the first mention of each glossary term becomes a term link.
//
// SAFETY: every source line goes through escMd before any tag is added, and every tag is built
// here with escaped or scheme-filtered content. That is why the output may be set as innerHTML,
// and why linkifyTerms may split on /(<[^>]+>)/. Do not feed it HTML from anywhere else.
import { findTermMatches, firstMatchPerTerm, signpostHint, type TermIndex, type TermMatch } from '@shared/glossary.js';

export function escMd(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const imageUrl = (url: string) => (/^(https?:\/\/|\/attachments\/)/.test(url) ? url : `/attachments/${url}`);

export function mdToHtml(text: string | undefined | null, terms: TermIndex | null, seen: Set<string> = new Set()): string {
  if (!text) return '';

  function inlineFormat(line: string, opts: { terms?: boolean } = {}): string {
    let s = escMd(line);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    s = s.replace(/\*(?!\*)(.+?)(?<!\*)\*/g, '<em>$1</em>');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `<img src="${imageUrl(url)}" alt="${alt}" loading="lazy">`);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => {
      const safe = /^https?:\/\//i.test(url) ? url : '#';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });
    s = s.replace(/\b([A-Z]{2,10}-\d{2,5})\b(?![^<]*<\/(?:code|a)>)/g, (_, id) => `<span class="md-entity-ref" data-ref-id="${id}">${id}</span>`);
    if (opts.terms !== false) s = linkifyTerms(s);
    return s;
  }

  function linkifyTerms(html: string): string {
    if (!terms || terms.size === 0) return html;
    const parts = html.split(/(<[^>]+>)/);
    let skip = 0;
    let out = '';
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k];
      if (k % 2 === 1) {
        if (/^<(code|a)\b/i.test(part) || /^<span[^>]*md-entity-ref/i.test(part)) skip++;
        else if (/^<\/(code|a|span)>/i.test(part) && skip > 0) skip--;
        out += part;
        continue;
      }
      out += skip > 0 ? part : replaceFirstTerms(part, terms);
    }
    return out;
  }

  function replaceFirstTerms(text: string, index: TermIndex): string {
    const matches = firstMatchPerTerm(findTermMatches(text, index)).filter((m) => !seen.has(m.termId));
    if (!matches.length) return text;
    let out = '';
    let cur = 0;
    for (const m of matches) {
      seen.add(m.termId);
      out += text.slice(cur, m.start) + termSpan(m);
      cur = m.end;
    }
    return out + text.slice(cur);
  }

  // A signpost (a word with two meanings) gets a warning chip, never a link.
  function termSpan(m: TermMatch): string {
    const cls = m.kind === 'signpost' ? 'md-term md-term-ambiguous' : 'md-term';
    const tip = m.kind === 'signpost' ? signpostHint(m.targetTitles) : m.title;
    return `<span class="${cls}" data-term-id="${escMd(m.termId)}" title="${escMd(tip)}">${m.text}</span>`;
  }

  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(escMd(lines[i++]));
      i++;
      out.push(`<pre><code${lang ? ` class="language-${escMd(lang)}"` : ''}>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)/.exec(line);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${inlineFormat(heading[2], { terms: false })}</h${n}>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${mdToHtml(quote.join('\n'), terms, seen)}</blockquote>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      if (rows.length >= 2) {
        const cells = (row: string) => row.split('|').slice(1, -1).map((c) => c.trim());
        const headers = cells(rows[0]);
        let tbl = '<table><thead><tr>';
        for (const h of headers) tbl += `<th>${inlineFormat(h, { terms: false })}</th>`;
        tbl += '</tr></thead><tbody>';
        for (const r of rows.slice(2)) {
          const c = cells(r);
          tbl += '<tr>';
          for (let ci = 0; ci < headers.length; ci++) tbl += `<td>${inlineFormat(c[ci] || '')}</td>`;
          tbl += '</tr>';
        }
        out.push(tbl + '</tbody></table>');
      }
      continue;
    }
    if (/^(\s*)[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*]\s+/.test(lines[i])) {
        const indent = /^(\s*)/.exec(lines[i])![1].length;
        const content = lines[i].replace(/^\s*[-*]\s+/, '');
        if (indent >= 2 && items.length > 0) items[items.length - 1] += `<ul><li>${inlineFormat(content)}</li></ul>`;
        else items.push(`<li>${inlineFormat(content)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) items.push(`<li>${inlineFormat(lines[i++].replace(/^\d+\.\s+/, ''))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      const alt = escMd(img[1]);
      out.push(`<figure class="md-figure"><img src="${imageUrl(img[2])}" alt="${alt}" loading="lazy">${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,4}\s|[-*]\s+|\d+\.\s+|\||>\s?|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])) {
      para.push(inlineFormat(lines[i++]));
    }
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('\n');
}
