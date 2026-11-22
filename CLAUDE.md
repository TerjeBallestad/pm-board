# pm board (pm 1.x)

One ASP.NET Core server that holds every repo's board, a React dashboard, and (coming) a thin `pm`
CLI. The work is planned on the pm board: **PLAN-001** in project SPRINT-001. Read the plan's
setup notes before you start: `pm plan PLAN-001`. Decisions are DD-001 to DD-015: `pm get DD-0NN`.

Two words, one meaning each (DD-015, `pm glossary`): a **board** is one repo's whole board, at
`/<slug>` and `/api/boards/{slug}`. A **project** is a SPRINT-NNN record inside a board, as in 0.x.
Never use "project" for a board.

## The contract is 0.x

pm-board-cli (~/dev/pm-board-cli, the 0.x line) defines what 1.x must do. `lib/dispatch.js`
ROUTE_TABLE lists every route, `api/*.js` holds each handler, `dashboard/app.js` holds the
dashboard's logic. Read the 0.x code before you build its 1.x side, and match it. Change a 0.x
behaviour only with a DD that says why.

## Layout

```
server/   PmBoard.slnx: src/PmBoard.Api (minimal API, EF Core, Npgsql), tests/PmBoard.Api.Tests
          docs/data-model.md: the schema and the mapping from 0.x. Keep it current.
client/   Vite + React + TS dashboard on @terjeballestad/bob; e2e/ holds the Playwright tests
cli/      the 1.x `pm` command (bin/pm: 0.x's bin/pm over HTTP, DD-021); lib/ holds copies of shared/
shared/   glossary.js: 0.x's glossary module, unchanged, plain ESM (its test enforces that)
shared/   also knowledge-base.js: the CLI appends knowledge-base results to prompts with it (DD-017)
tools/    export-v0.mjs, compare-read.mjs, compare-write.mjs, compare-cli.mjs, v0-board.mjs: read 0.x
          boards with the 0.x code itself; fixtures/write-board is the golden checks' 0.x board
```

## Checks before you push

Run every one. CI runs the same.

```sh
# Server. The tests start Postgres in Docker (Colima on this Mac).
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
colima status || colima start
cd server && dotnet test

# Client
cd client && npx tsc -p tsconfig.json && npm run build
node --test shared/glossary.test.mjs

# e2e: wipes the database you point it at, imports e2e/fixture.json, serves client/dist
docker run -d --name pmb-e2e-pg -p 55433:5432 -e POSTGRES_USER=pm_board -e POSTGRES_PASSWORD=pm_board -e POSTGRES_DB=pm_board postgres:18
cd client && E2E_PG=postgres://pm_board:pm_board@localhost:55433/pm_board npm run e2e
```

When you touch the write side or the CLI, run the golden write and CLI checks (CI runs them too):
each adds a board to the database you give it and starts its own server.

```sh
dotnet build server/PmBoard.slnx && (cd tools && npm install)
PMB_PG=postgres://pm_board:pm_board@localhost:55433/pm_board node tools/compare-write.mjs
(cd cli && npm test)   # cli/lib's copies of shared/ are current: after a change, npm run sync-shared
PMB_PG=postgres://pm_board:pm_board@localhost:55433/pm_board node tools/compare-cli.mjs
```

When you touch the read side (routes, V0Json, the importer), also run the golden check against the
real boards: export each board, import into a scratch Postgres, start the server, then
`node tools/compare-read.mjs ~/dev/<repo> <slug> http://localhost:5055 <dump>.report.json`.
Every board must print `no differences`. See README.md for the commands.

Red-green: when you add a test, break the code it guards once and watch it fail.

## Traps already hit

- **zsh**: an unquoted `$VAR` holding several words is not split. Pass file lists through `xargs`.
  `rm` on a `$VAR` path needs `"${VAR:?}"`.
- **EF migrations**: `ASPNETCORE_ENVIRONMENT=Development dotnet ef migrations add <Name> --project src/PmBoard.Api --output-dir Data/Migrations`.
  `migrations remove` needs a database; without one use `--force`, and only for a migration that
  never ran outside your machine. A migration that ran in the cluster is never removed or edited:
  add a new one.
- **EF sorts inserts by primary key**, so insert order is not array order. Anything ordered needs an
  explicit column (comments have `position`).
- **xUnit has its own `Record` type.** Tests use `using Record = PmBoard.Api.Data.Record;`.
- **jsonb** keeps no key order, and a typed column cannot tell a missing field from null. The golden
  tools compare as data for that reason (server/docs/data-model.md, "Known differences").
- A 0.x board's data dir can hold its own `.git`: the tools skip hidden folders.

## Working in parallel

Several sessions may work on PLAN-001 at once (the plan says which tasks can).

- Take a task: `pm task-update PLAN-001 <TASK> --status in_progress --note "<who>: started"`.
  If it is already in progress, pick another. Log progress the same way, with evidence (commit,
  test counts, what you broke to see a test fail). Close with `pm task-done`.
- Work in a worktree: `git worktree add .claude/worktrees/<task> -b <task>`. `pm` works there too
  (the untracked pm.config.json at the repo root points at the board in pm-board-cli).
- Rebase on `main`, run the checks, push to `main`. Never force-push `main`. Two sessions that both
  add an EF migration: the second rebases, removes its migration with `--force`, and adds it again.
- Decisions go on the board as DDs: `pm create decision "<one-sentence decision>" --sprint SPRINT-001 --body "..."`.

## Deploy

CI pushes `ghcr.io/terjeballestad/pm-board:<sha>` on every push to `main` once all jobs pass. To
release, set that sha in ~/dev/homelab `k8s/pm-board/deployment.yaml` and push homelab; ArgoCD
syncs it, and the server runs its migrations at start. Check https://pm.godstemning.dev/api/health.
The database is `pm_board` on the CloudNativePG cluster `pg` (homelab k8s/postgres/README.md).
Do not import boards into the cluster outside PLAN-001 Task 10 and 11.

## Writing

Commit messages: a summary line, then a body that says what changed and why, and how it was
checked. Docs and DDs: short active sentences, one idea each, as in the existing ones.
