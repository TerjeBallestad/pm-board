// Types for glossary.js, which stays plain ESM so it can be shared verbatim (see glossary.test.mjs).
export interface TermLike {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  aliases?: string[];
  related?: string[];
}
export interface TermMeta {
  kind: 'term' | 'signpost';
  title: string;
  targetTitles: string[];
}
export interface TermIndex {
  size: number;
  terms: Map<string, TermMeta>;
  conflicts: unknown[];
}
export interface TermMatch {
  start: number;
  end: number;
  text: string;
  termId: string;
  title: string;
  kind: 'term' | 'signpost';
  targetTitles: string[];
}
export const TERM_TYPE: 'term';
export function isTerm(item: unknown): boolean;
export function buildTermIndex(terms: TermLike[], opts?: { minLength?: number; transform?: (s: string) => string }): TermIndex;
export function findTermMatches(text: string, index: TermIndex): TermMatch[];
export function firstMatchPerTerm(matches: TermMatch[]): TermMatch[];
export function signpostHint(targetTitles: string[]): string;
export function describeConflict(c: unknown): string;
