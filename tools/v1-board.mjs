// A 1.x board for a golden check: a 0.x fixture exported with the 0.x code, imported under a new
// slug into the Postgres at pgUrl (nothing is wiped), a token for a user named `user`, and a server
// on a free port, unless `base` points at one that uses the same database. Build the server first
// (dotnet build server/PmBoard.slnx).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export async function startV1Board({ fixture, slug, pgUrl, base = null }) {
  const u = new URL(pgUrl);
  const npgsql = `Host=${u.hostname};Port=${u.port || 5432};Database=${u.pathname.slice(1)};Username=${decodeURIComponent(u.username)};Password=${decodeURIComponent(u.password)}`;
  const env = { ...process.env, ConnectionStrings__pmboard: npgsql, Logging__LogLevel__Default: 'Warning' };
  const project = here('../server/src/PmBoard.Api');
  const dotnet = (...args) => spawnSync('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project, '--', ...args], { env, encoding: 'utf8' });

  const work = mkdtempSync(join(tmpdir(), 'pm-v1-'));
  const dumpPath = join(work, 'dump.json');
  const exp = spawnSync(process.execPath, [here('./export-v0.mjs'), fixture, '--slug', slug], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (exp.status !== 0) throw new Error(`export failed: ${exp.stderr}`);
  writeFileSync(dumpPath, exp.stdout);
  const imp = dotnet('import', dumpPath);
  if (imp.status !== 0) throw new Error(`import failed: ${imp.stdout}\n${imp.stderr}`);
  // Writes need a token (DD-003). Its user is named "user": a comment with no author records the
  // token's user in 1.x, where 0.x wrote "user" (DD-020), so this name keeps the two sides equal.
  const mint = dotnet('token', 'create', '--user', 'user', '--name', slug);
  if (mint.status !== 0) throw new Error(`token create failed: ${mint.stdout}\n${mint.stderr}`);
  const token = mint.stdout.trim();

  let server = null;
  if (!base) {
    const port = 5300 + Math.floor(Math.random() * 600);
    base = `http://localhost:${port}`;
    server = spawn('dotnet', ['run', '--no-build', '--no-launch-profile', '--project', project], {
      env: { ...env, ASPNETCORE_URLS: base },
      stdio: ['ignore', process.env.PMB_SERVER_LOG ? 'inherit' : 'ignore', 'inherit'],
    });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 120) throw new Error('the server did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    slug,
    base,
    token,
    close: () => {
      server?.kill('SIGTERM');
      rmSync(work, { recursive: true, force: true });
    },
  };
}
