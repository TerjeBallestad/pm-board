// Bob 1.2+ (DD-038): the dashboard sets type with one Bob text style per element (text-label,
// text-note, text-heading, ...). A style sets the size, line height, letter spacing and weight
// together, so a leading-*, tracking-* or font weight class next to it is a style Bob does not
// have. `uppercase` and `font-mono` are the only type classes written next to a style.
//
// The components carry their classes as string literals; app.css keeps element rules for the
// markdown body, and those take their type from Bob's styles through @apply. This test reads both.
// It sees one string literal at a time: classes that cx() joins from two constants are checked in
// the rendered DOM by e2e/bob-text-styles.spec.ts.
//
// Run: node --test client/test/bob-text-styles.test.mjs (or `npm test` in client/)
//
// ## Verified red-green: 2026-11-28 (TASK-034, Bob 1.4) — eight breaks at once fail all eight
//   tests, each with its file: an empty src/x.module.css; the brand as `text-heading font-bold`;
//   the detail key as `font-mono text-[12px]`; the inbox kind with `fontWeight: 600` inline; the
//   quick-open key as `text-caption text-tiny`; the search button with `font-sans` before
//   `text-body`; `.md h2` with `font-size: 16px` and `.md h3` as `@apply text-heading text-base`;
//   the code block's colour back to #c9cbd4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(CLIENT, 'src');

const files = (dir, pattern) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });

// Bob's text styles (Bob 1.4). A colour (text-muted) or an alignment (text-left) is not one.
const STYLES = 'micro|tiny|id|label|caption|note|figure|body|subhead|item|base|prose|heading|title|headline|display';
const STYLE = new RegExp(`(?<![\\w-])text-(?:${STYLES})(?![\\w-])`, 'g');
// Tailwind's weight, line-height and letter-spacing utilities, and text-doc (now text-display).
const OFF_STYLE =
  /(?<![\w-])(?:leading-[\w[\]().%-]+|tracking-[\w[\]().%-]+|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|text-doc)(?![\w-])/g;
// A size, family or weight written as a custom value: text-[12px], text-(length:--fs-tiny),
// font-[600], font-(--mono).
const ARBITRARY_TYPE = /(?<![\w-])(?:text-\[(?:\d|length:)[^\]]*\]|text-\(length:[^)]*\)|font-[[(][^\])]*[\])])/g;
// A font-* class other than font-mono: a family or a weight.
const FONT_NOT_MONO = /(?<![\w-])font-(?!mono(?![\w-]))[a-z][\w-]*/g;
// Type in an inline style object.
const INLINE_TYPE = /\b(?:fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|fontStyle)\s*:/g;

/** The file without its comments, so a comment may name a class. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sources = files(SRC, /\.(ts|tsx)$/);
const read = (path) => code(readFileSync(path, 'utf8'));
/** Every string literal in the file: the classes of one element, or a part of them. */
const literals = (path) => [...read(path).matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)].map((m) => m[0]);
const matches = (pattern) =>
  sources.flatMap((path) => [...read(path).matchAll(pattern)].map((m) => `${relative(CLIENT, path)}: ${m[0]}`));

const APP_CSS = join(SRC, 'app.css');
/** app.css as [selector, body] rules, comments removed, the base layer left out (element resets). */
const cssRules = () => {
  const css = readFileSync(APP_CSS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@layer base \{[\s\S]*?\n\}/, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
};

test('reads every component, and app.css is the only stylesheet', () => {
  for (const name of ['Frame.tsx', 'Lists.tsx', 'Project.tsx', 'Detail.tsx', 'QuickOpen.tsx', 'App.tsx', 'classes.ts']) {
    assert.ok(
      sources.some((path) => path.endsWith(name)),
      `${name} not read`,
    );
  }
  assert.deepEqual(
    files(SRC, /\.css$/).map((path) => relative(CLIENT, path)),
    ['src/app.css'],
  );
});

test('no component sets a weight, line height or letter spacing as a class', () => {
  assert.deepEqual(matches(OFF_STYLE), []);
});

test('no component sets a size, family or weight as a custom value', () => {
  assert.deepEqual(matches(ARBITRARY_TYPE), []);
});

test('no component sets type in an inline style', () => {
  assert.deepEqual(matches(INLINE_TYPE), []);
});

test('no class string holds two text styles', () => {
  const found = sources.flatMap((path) =>
    literals(path)
      .filter((literal) => (literal.match(STYLE) ?? []).length > 1)
      .map((literal) => `${relative(CLIENT, path)}: ${literal}`),
  );
  assert.deepEqual(found, []);
});

test('no class string sets a font-* class other than font-mono next to a text style', () => {
  const found = sources.flatMap((path) =>
    literals(path)
      .filter((literal) => literal.match(STYLE) && literal.match(FONT_NOT_MONO))
      .map((literal) => `${relative(CLIENT, path)}: ${literal}`),
  );
  assert.deepEqual(found, []);
});

test('app.css sets type only through @apply of one Bob text style per rule', () => {
  // The one exception: the task box's check is a glyph, sized as an icon.
  const GLYPHS = new Set(['.pm-task-box']);
  const found = [];
  for (const [selector, body] of cssRules()) {
    const own = body.match(/(?:^|;)\s*(?:font-size|font-weight|line-height|letter-spacing|font-family|font)\s*:[^;]*/g) ?? [];
    if (own.length && !GLYPHS.has(selector)) found.push(`${selector}: ${own.map((d) => d.replace(/^[;\s]+/, '')).join('; ')}`);
    for (const apply of body.match(/@apply[^;]*/g) ?? []) {
      if ((apply.match(STYLE) ?? []).length > 1) found.push(`${selector}: ${apply} (two styles)`);
      const off = [...(apply.match(OFF_STYLE) ?? []), ...(apply.match(FONT_NOT_MONO) ?? [])];
      if (off.length) found.push(`${selector}: ${apply} (${off.join(', ')})`);
    }
  }
  assert.deepEqual(found, []);
});

test('every raw colour in app.css names its BOB GAP', () => {
  const found = readFileSync(APP_CSS, 'utf8')
    .split('\n')
    .filter((line) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(line) && !line.includes('BOB GAP'))
    .map((line) => line.trim());
  assert.deepEqual(found, []);
});
