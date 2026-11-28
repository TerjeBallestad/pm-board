// Class lists that several components share. Each is Tailwind utilities over Bob's tokens, with one
// Bob text style per element (DD-038). The rest of a component's classes sit on its elements.

/** Joins class names and drops the empty ones. */
export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** Grey meta in mono: a count, a key in a list, progress. */
export const monoDim = 'font-mono text-tiny text-muted';
/** A short age at the end of a row. */
export const age = 'ml-auto shrink-0 font-mono text-tiny text-faint';
/** Mono meta: a time, a sub line, a "not found" line. */
export const dimText = 'font-mono text-caption text-muted';
/** A one-line hint. */
export const hint = 'text-caption text-muted';
/** A short line where a list is empty. */
export const emptyInline = 'px-1 py-2 text-body text-muted';
/** A view with nothing to show. */
export const empty = 'px-5 py-15 text-center text-base text-muted';
/** The done mark. */
export const check = 'text-body text-green';
/** A row or card that opens a record: no button chrome. */
export const plainButton = 'cursor-pointer border-0 bg-transparent text-left';
/** A record key as a small tinted chip; the caller sets its colour. */
export const waitChip = 'cursor-pointer rounded-kbd border-0 px-1.5 py-px font-mono text-tiny';
/** An outlined mono chip: a related key, an alias, a refinement count. */
export const chip = 'cursor-pointer rounded-chip border border-strong bg-transparent px-2 py-px font-mono text-caption text-secondary';
/** A ticket key on a card or a map row; the caller sets its colour. */
export const cardId = 'font-mono text-id';
/** A kind tag on a card (task, grill, ...); the caller sets its colour. */
export const cardKind = 'text-micro uppercase';
/** A card on the project map. */
export const pcard = 'cursor-pointer rounded-lg border border-subtle px-3 py-2.75 hover:bg-card-hover';
/** The id, kind and age line at the top of a card. */
export const pcardTop = 'mb-1.25 flex items-center gap-2';
/** A decision or term key. */
export const ddId = 'shrink-0 font-mono text-caption text-blue';
/** The id and title line of a featured decision or a term. */
export const ddHead = 'mb-1.5 flex flex-wrap items-baseline gap-2.5';
/** A featured decision or a glossary term. */
export const featured = 'mb-2.5 cursor-pointer rounded-lg border border-subtle bg-card px-4 py-3.5';
/** A decision or term title in a card. */
export const featuredTitle = 'text-title';
/** A list of files in mono. */
export const files = 'pl-4.5 font-mono text-caption text-secondary';
/** A section in the detail panel. */
export const section = 'mt-4.5';
/** A row that turns lighter under the pointer. */
export const hoverRow = 'rounded-md hover:bg-card-hover';
