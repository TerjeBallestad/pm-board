import { expect, test, type Page } from '@playwright/test';

// DD-038 in the browser: in every view and state, no element carries two Bob text styles, and none
// carries a leading-*, tracking-* or font-* class (other than font-mono) next to a style.
//
// test/bob-text-styles.test.mjs reads the source one string literal at a time, so it cannot see
// classes that cx() joins from two constants (cx(monoDim, 'text-caption')). The rendered DOM has
// the joined class list, so this scan sees what each element gets.
//
// ## Verified red-green: 2026-11-28 (TASK-034, Bob 1.4) — each break alone fails this test, with
//   the view and the element in the message, while test/bob-text-styles.test.mjs stays green:
//   Frame's project progress as cx(monoDim, 'shrink-0 text-caption') (two styles, every board
//   view); Detail's task status as cx('... font-mono text-tiny', 'font-sans', ...) (the plan with
//   its tasks). And the scan checks that each view is there: the project map's card titles as
//   `text-body` fail 'project map card titles'.

const B = '/e2e';

// Bob's text styles, as whole class names. A colour (text-muted) or an alignment is not one.
const STYLE = '^text-(?:micro|tiny|id|label|caption|note|figure|body|subhead|item|base|prose|heading|title|headline|display)$';
// Type classes an app does not write next to a style: font-* other than font-mono, leading-*,
// tracking-*.
const OFF = '^(?:font-(?!mono$)[a-z][\\w-]*|leading-.+|tracking-.+)$';

/** Every element in the document whose classes break the rules, as "TAG classes | text". */
function scan(page: Page) {
  return page.evaluate(
    ([styleSrc, offSrc]) => {
      const style = new RegExp(styleSrc);
      const off = new RegExp(offSrc);
      const bad: string[] = [];
      for (const el of document.querySelectorAll('[class]')) {
        const cls = String(el.getAttribute('class')).split(/\s+/);
        const styles = cls.filter((c) => style.test(c));
        const offs = cls.filter((c) => off.test(c));
        if (styles.length > 1 || (styles.length && offs.length)) {
          const what = (el.textContent || el.getAttribute('placeholder') || '').trim();
          bad.push(`${el.tagName} ${[...styles, ...offs].join(' ')} | ${what.slice(0, 24)}`);
        }
      }
      return bad;
    },
    [STYLE, OFF],
  );
}

test('no element in any view has two text styles, or a type class next to one', async ({ page }) => {
  const found: Record<string, string[]> = {};
  const seen: Record<string, number> = {};
  const visit = async (name: string) => {
    const bad = await scan(page);
    if (bad.length) found[name] = bad;
  };
  /** The scan sees only what is on the page, so each step checks that its elements are there. */
  const count = async (name: string, selector: string) => (seen[name] = await page.locator(selector).count());
  const go = async (path: string, ready: string) => {
    await page.goto(path);
    await expect(page.locator(ready).first()).toBeVisible();
  };

  await go('/', 'text=E2E Board');
  await count('home title', 'h1.text-display');
  await visit('home');

  await go(`${B}/tickets`, '.pm-kanban');
  await count('kanban column titles', '.pm-column-title.text-heading');
  await count('sidebar project progress', '.pm-projects .font-mono.text-tiny');
  await count('rail activity', '.pm-rail .text-note');
  await visit('tickets');
  for (const [view, ready] of [
    ['inbox', 'text=SB-001'],
    ['documents', 'text=Widget layout'],
    ['plans', 'text=Build the widget'],
    ['decisions', 'text=Widgets are square'],
    ['glossary', 'text=A small square thing on the board.'],
  ]) {
    await go(`${B}/${view}`, ready);
    await visit(view);
  }
  await count('glossary term titles', '.text-title');
  await go(`${B}/archive`, 'text=An old ticket');
  await page.getByText('An old ticket').click();
  await expect(page.getByText('Old body text.')).toBeVisible();
  await visit('archive, a row open');

  await go(`${B}/project/SPRINT-001`, '.pm-strip');
  await count('project map card titles', '.pm-pcol .text-subhead');
  await count('project map labels', '.pm-exec-strip .text-label');
  await visit('project map');
  await go(`${B}/project/SPRINT-001?mode=board`, '.pm-kanban');
  await visit('project board');

  for (const id of ['SB-001', 'DD-001', 'SDD-001', 'SPRINT-001', 'NOPE-1']) {
    await go(`${B}/tickets?open=${id}`, '.pm-slide');
    await visit(`detail ${id}`);
  }
  await go(`${B}/plans?open=PLAN-001`, '.pm-slide');
  await page.locator('.pm-slide summary', { hasText: 'Context' }).click();
  await page.getByText('Task 1: make it').click();
  await expect(page.locator('.pm-slide')).toContainText('made it');
  await count('plan task status', '.pm-slide .font-mono.text-tiny');
  await count('detail title', '.pm-slide h1.text-display');
  await visit('detail PLAN-001, a task open');

  await go(`${B}/tickets`, '.pm-kanban');
  await expect(page.locator('.pm-column').getByText('SB-001').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.pm-qo-input').fill('wid');
  await count('quick open rows', '.pm-qo-row');
  await visit('quick open');

  await go('/no-such-board/tickets', 'text=There is no board called');
  await visit('missing board');

  for (const [name, n] of Object.entries(seen)) expect(n, name).toBeGreaterThan(0);
  expect(found).toEqual({});
});
