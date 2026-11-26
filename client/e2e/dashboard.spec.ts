import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

// The fixture board is e2e/fixture.json, imported fresh by e2e/stack.mjs.
const B = '/e2e';

async function sql(text: string, values: unknown[] = []) {
  const db = new pg.Client({ connectionString: process.env.E2E_PG });
  await db.connect();
  try {
    return await db.query(text, values);
  } finally {
    await db.end();
  }
}

const card = (page: Page, id: string) => page.locator('.pm-column').locator(`text=${id}`).first();

test('the home page lists the boards', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('E2E Board')).toBeVisible();
  await page.getByText('E2E Board').click();
  await expect(page).toHaveURL(/\/e2e\/tickets$/);
});

test('the kanban puts tickets, maps and plans in their stage columns, and keeps decisions and terms off it', async ({ page }) => {
  await page.goto(`${B}/tickets`);
  const column = (name: string) => page.locator('.pm-column', { has: page.locator('.pm-column-title', { hasText: name }) });
  await expect(column('Inbox')).toContainText('SB-001');
  await expect(column('Inbox')).toContainText('SB-003');
  await expect(column('Exploring')).toContainText('SB-002');
  await expect(column('Sdd')).toContainText('SDD-001');
  await expect(column('Planned')).toContainText('PLAN-001');
  await expect(column('Planned')).toContainText('1/2');
  await expect(column('Done')).toContainText('SB-004');
  await expect(page.locator('.pm-kanban').getByText('DD-001', { exact: true })).toHaveCount(0);
  await expect(page.locator('.pm-kanban').getByText('TERM-001', { exact: true })).toHaveCount(0);
  await expect(column('Inbox')).toContainText('⊘ SB-002');
});

test('the sidebar counts match the board', async ({ page }) => {
  await page.goto(`${B}/tickets`);
  const nav = page.locator('.pm-nav');
  await expect(nav.getByText('Inbox').locator('..')).toContainText('2');
  await expect(nav.getByText('Tickets').locator('..')).toContainText('3');
  await expect(nav.getByText('Decisions').locator('..')).toContainText('1');
  await expect(nav.getByText('Glossary').locator('..')).toContainText('1');
  await expect(page.locator('.pm-projects')).toContainText('Widget project');
  await expect(page.locator('.pm-projects')).toContainText('1/4');
});

test('the project map splits its tickets into frontier, blocked and resolved', async ({ page }) => {
  await page.goto(`${B}/project/SPRINT-001`);
  await expect(page.locator('.pm-strip')).toContainText('Every board has a widget');
  const col = (name: string) => page.locator('.pm-pcol', { has: page.locator('.pm-pcol-title', { hasText: name }) });
  await expect(col('Frontier')).toContainText('SB-001');
  await expect(col('Frontier')).toContainText('SB-002');
  await expect(col('Blocked')).toContainText('SB-003');
  await expect(col('Resolved')).toContainText('SB-004');
  await expect(page.locator('.pm-exec-strip').first()).toContainText('SDD-001');
});

test('each list view shows its records', async ({ page }) => {
  for (const [view, text] of [
    ['inbox', 'SB-001'],
    ['documents', 'Widget layout'],
    ['plans', 'Build the widget'],
    ['decisions', 'Widgets are square'],
    ['glossary', 'A small square thing on the board.'],
  ]) {
    await page.goto(`${B}/${view}`);
    await expect(page.locator('.pm-content')).toContainText(text);
  }
  await page.goto(`${B}/archive`);
  await page.getByText('An old ticket').click();
  await expect(page.locator('.pm-content')).toContainText('Old body text.');
});

test('a detail panel renders the body, links glossary terms and keys, and shows the thread', async ({ page }) => {
  await page.goto(`${B}/tickets?open=SB-001`);
  const panel = page.locator('.pm-slide');
  await expect(panel).toContainText('Wire the frontier');
  await expect(panel.locator('.md strong', { hasText: 'widget' })).toBeVisible();
  await expect(panel.locator('.pm-meta-row')).toContainText('high');
  await expect(panel).toContainText('First note');
  // A key in the body opens that record.
  await panel.locator('.md-entity-ref', { hasText: 'SB-002' }).click();
  await expect(page).toHaveURL(/open=SB-002/);
  await expect(panel).toContainText('Rule on the widget');
  // The first mention of a term is a link to it.
  await page.goBack();
  await expect(panel).toContainText('Wire the frontier');
  await panel.locator('.md-term', { hasText: 'widget' }).click();
  await expect(page).toHaveURL(/open=TERM-001/);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('a plan shows its tasks with their notes', async ({ page }) => {
  await page.goto(`${B}/plans?open=PLAN-001`);
  const panel = page.locator('.pm-slide');
  await expect(panel).toContainText('1/2 done');
  await panel.getByText('Task 1: make it').click();
  await expect(panel).toContainText('made it');
  await expect(panel).toContainText('glue');
});

test('Start copies the configured command', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${B}/tickets?open=SB-001`);
  await page.getByRole('button', { name: '⧉ Start' }).click();
  await expect(page.getByText('Copied: /work SB-001')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/work SB-001');
});

test("Bob's component classes come from the app's Tailwind build and win over its element rules", async ({ page }) => {
  // DD-031: app.css imports @terjeballestad/bob/tailwind.css. Its button rule sits in @layer base;
  // unlayered, `button { font: inherit; color: inherit }` would beat Bob's btn and nav-row classes.
  await page.goto(`${B}/tickets?open=SB-001`);
  const start = page.getByRole('button', { name: '⧉ Start' });
  await expect(start).toHaveClass(/\bbtn btn-sm btn-primary\b/);
  await expect(start).toHaveCSS('font-size', '11.5px');
  await expect(start).toHaveCSS('color', 'rgb(15, 16, 20)');
  const active = page.locator('.pm-nav .nav-row-active');
  await expect(active).toHaveCSS('font-size', '12.5px');
  await expect(active).toHaveCSS('font-weight', '600');
  const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n'));
  expect(css).toMatch(/@layer utilities \{[\s\S]*\.btn-sm \{/);
});

test('quick open finds a record by key or title', async ({ page }) => {
  await page.goto(`${B}/tickets`);
  // The shortcut listens once the board has rendered; a key pressed before that is lost.
  await expect(card(page, 'SB-001')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('.pm-qo-input').fill('widget lay');
  await expect(page.locator('.pm-qo-row').first()).toContainText('SDD-001');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/open=SDD-001/);
});

test('a change in the database shows on the open board without a reload', async ({ page }) => {
  await page.goto(`${B}/tickets`);
  await expect(card(page, 'SB-002')).toBeVisible();
  // Wait until the event stream is open: the dot next to the board name turns live.
  await expect(page.locator('[data-live="true"]')).toBeVisible();
  await sql("UPDATE records SET title = '[grill] Ruled live', stage = 'done' WHERE key = 'SB-002' AND board_id = (SELECT id FROM boards WHERE slug = 'e2e')");
  const done = page.locator('.pm-column', { has: page.locator('.pm-column-title', { hasText: 'Done' }) });
  await expect(done).toContainText('Ruled live', { timeout: 10_000 });
  // Put it back for any later test.
  await sql("UPDATE records SET title = '[grill] Rule on the widget', stage = 'exploring' WHERE key = 'SB-002' AND board_id = (SELECT id FROM boards WHERE slug = 'e2e')");
});

test('an unknown board says so', async ({ page }) => {
  await page.goto('/no-such-board/tickets');
  await expect(page.getByText('There is no board called “no-such-board”.')).toBeVisible();
});
