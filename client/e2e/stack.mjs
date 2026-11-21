// The stack the e2e tests run against: an empty database, the fixture board imported, and the real
// server on :5199 serving the built client (client/dist). Playwright starts it (playwright.config.ts).
// Needs E2E_PG, a connection string to a Postgres the tests may wipe, and a built client.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const url = process.env.E2E_PG;
if (!url) throw new Error('set E2E_PG to a Postgres connection string the tests may wipe');
if (!existsSync(here('../dist/index.html'))) throw new Error('build the client first: npm run build');

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await db.end();

const u = new URL(url);
const npgsql = `Host=${u.hostname};Port=${u.port || 5432};Database=${u.pathname.slice(1)};Username=${decodeURIComponent(u.username)};Password=${decodeURIComponent(u.password)}`;
const env = { ...process.env, ConnectionStrings__pmboard: npgsql, Logging__LogLevel__Default: 'Warning' };
const project = here('../../server/src/PmBoard.Api');

const imp = spawnSync('dotnet', ['run', '--no-launch-profile', '--project', project, '--', 'import', here('./fixture.json')], { env, stdio: 'inherit' });
if (imp.status !== 0) process.exit(imp.status ?? 1);

const server = spawn('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project, '--webroot', here('../dist')], {
  env: { ...env, ASPNETCORE_URLS: 'http://localhost:5199' },
  stdio: 'inherit',
});
const stop = () => server.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));
