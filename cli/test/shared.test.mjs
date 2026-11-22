// cli/lib holds copies of shared/glossary.js and shared/knowledge-base.js, because the npm package
// can only ship files inside cli/. shared/ is the one source: `npm run sync-shared` copies it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const name of ['glossary.js', 'knowledge-base.js']) {
  test(`cli/lib/${name} is the same as shared/${name}`, () => {
    const shared = readFileSync(new URL(`../../shared/${name}`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8');
    assert.equal(copy, shared, `run: cd cli && npm run sync-shared`);
  });
}
