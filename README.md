# pm board

`pm` 1.x: one server that holds every repo's board. Agents and people use the same `pm`
commands as in 0.x, and the server is the only place that gives out ids, so two agents in two
worktrees can never both make `SB-042`.

The 0.x line, the local-first edition with files in each repo, lives in
[pm-board-cli](https://github.com/TerjeBallestad/pm-board-cli).

The plan and the decisions are on the pm board: project SPRINT-001, PLAN-001, DD-001 to DD-015. A **board** is one repo's
whole board, at `/<slug>`. A **project** is a SPRINT-NNN record inside a board, as in 0.x.

## Layout

```
server/   ASP.NET Core 10 minimal API, EF Core on Postgres (PmBoard.slnx)
client/   Vite + React + TypeScript dashboard, built into the API's wwwroot
```

`cli/` (the 1.x thin client) comes in a later task. `shared/` holds the glossary and the
knowledge-base append for prompts (DD-017). `tools/` holds `export-v0.mjs`, which reads a 0.x board
with the 0.x store for the importer, and the golden checks `compare-read.mjs` and
`compare-write.mjs`.

## Develop

```sh
# Postgres for the dev settings in appsettings.Development.json
docker run -d --name pm-board-pg -p 5432:5432 \
  -e POSTGRES_USER=pm_board -e POSTGRES_PASSWORD=pm_board -e POSTGRES_DB=pm_board postgres:18

cd server && dotnet run --project src/PmBoard.Api   # http://localhost:5055
cd client && npm install && npm run dev              # http://localhost:5174, proxies /api
```

## Test

```sh
cd server && dotnet test
```

The tests start their own Postgres through Testcontainers, so Docker must run. With Colima, set
`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.

## Import a 0.x board

```sh
cd tools && npm install
node export-v0.mjs ~/dev/time-turtle > time-turtle.json        # reads a copy, never the repo
cd ../server && ConnectionStrings__pmboard='...' \
  dotnet run --project src/PmBoard.Api -- import ../tools/time-turtle.json
```

Each dump is one board and one transaction. A board that exists is refused. The report next to
the dump lists clashes, skipped files, dangling references and times that did not parse. The rules
are in `server/docs/data-model.md`.

To check the read API against 0.x on a real board, with a server running that imported it:

```sh
node tools/compare-read.mjs ~/dev/time-turtle time-turtle http://localhost:5055 time-turtle.json.report.json
```

It asks 0.x (the 0.x code on a temp copy) and 1.x every read route, item by item, and compares the
answers as data. It also compares next-task and context for every plan, explore and suggest for
every project, and the prompt and review of every record. The importer's own changes from the
report are allowed.

To check the write API against 0.x, with a Postgres it may add a board to:

```sh
dotnet build server/PmBoard.slnx && (cd tools && npm install)
PMB_PG=postgres://pm_board:pm_board@localhost:5432/pm_board node tools/compare-write.mjs
```

It runs one script of about 90 requests against 0.x (on a temp copy of
`tools/fixtures/write-board`) and against 1.x (the same board imported under a new slug, on a
server it starts), and compares each answer and then every read route after each step. CI runs it.

## Routes

- `/api/health`: `{"ok": true}` when Postgres answers, 503 when it does not.
- `/api/boards`: every board, `{slug, name}`.
- `/api/boards/{slug}/...`: 0.x's read routes for that board, with the same JSON and filters:
  `config`, `items` (`type`, `stage`, `priority`, `sprintId`, `frontier`, `allClaims`),
  `items/archived`, `items/{id}`, `designs`, `designs/{id}`, `plans`, `plans/{id}`, `sprints`,
  `sprints/{id}`, `milestones`, `milestones/{id}`.
- Writes, per board, in 0.x's request and response shapes, with 0.x's error texts and status
  codes: `items` (POST), `items/{id}` (PATCH, DELETE), `items/{id}/comments`, `items/{id}/claim`,
  `items/{id}/release`, `items/archive`, `items/archive/sweep`; `designs` (POST), `designs/{id}`
  (PATCH), `designs/{id}/comments`; `plans` (POST), `plans/{id}` (PATCH), `plans/{id}/tasks`
  (POST), `plans/{id}/tasks/{taskId}` (PATCH), `plans/{id}/comments`; `sprints` (POST),
  `sprints/{id}` (PATCH), `sprints/{id}/items`, `sprints/{id}/comments`, `sprints/{id}/suggest`,
  `sprints/{id}/explore`; `context/prompt`, `context/review`. A PATCH with an unknown field is
  400 (DD-016). Prompt and review list their knowledge-base queries in `qmdQueries` for the CLI
  to run (DD-017). No auth yet: that is Task 7.
- `/api/boards/{slug}/plans/{id}/next-task` and `/plans/{id}/context`: 0.x's two plan reads.
- `PUT /api/boards/{slug}/tests`: every sidecar tests list of the board, `{"tests": {"DD-003":
  [...]}}`, for a repo's test catalogue tool (DD-019).
- `POST /api/boards/{slug}/attachments?name=x.png` (the image is the body) and `GET` on the same
  path for the list. `/attachments/<name>` serves the file, as in 0.x (DD-018).
- `/api/boards/{slug}/events`: a server-sent event stream of changes, in 0.x's shape
  (`data: {"entity":"item","id":"SB-042","action":"update"}`). Postgres triggers send every change
  to a record or comment, from any writer, so the dashboard is never stale. A `resync` event asks
  the client to load the board again.
- `/api/...`: an unknown API path is 404, never the client.
- Any other path serves the client, so `/<slug>` opens that board.

## Deploy

CI pushes `ghcr.io/terjeballestad/pm-board:<commit sha>` on each push to `main`. The homelab repo
deploys it to k3s on VM 200 (`k8s/pm-board/`) at `pm.godstemning.dev`, on the tailnet only. To
release, change the image tag in `k8s/pm-board/deployment.yaml` in the homelab repo. ArgoCD does
the rest.

The server reads its database from `ConnectionStrings:pmboard`. In the cluster it comes from the
sealed secret `pm-board-db` as `ConnectionStrings__pmboard`. The server runs its EF Core
migrations at start.
