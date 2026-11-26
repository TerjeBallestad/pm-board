# pm board

`pm` 1.x: one server that holds every repo's board. Agents and people use the `pm`
commands of 0.x, leaner since 1.1 (`pm help`), and the server is the only place that gives out ids, so two agents in two
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

`cli/` is the 1.x `pm` command, the npm package `@terjeballestad/pm-board-cli@1` (DD-021, and
cli/README.md). `shared/` holds the glossary and the knowledge-base append for prompts (DD-017); the
CLI ships copies in `cli/lib` (`npm run sync-shared`, and its test checks them). `tools/` holds
`export-v0.mjs`, which reads a 0.x board with the 0.x store for the importer, and the golden checks
`compare-read.mjs`, `compare-write.mjs` and `compare-cli.mjs`.

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

To check the CLI against 0.x, the same way (no longer in CI: from DD-025, help and exit codes
differ from 0.x on purpose, so this shows those differences; every other output still matches):

```sh
PMB_PG=postgres://pm_board:pm_board@localhost:5432/pm_board node tools/compare-cli.mjs
```

It runs about 160 `pm` commands with 0.x's `bin/pm` (serverless, on a temp copy of the fixture)
and with `cli/bin/pm` (against a server that imported it), and compares exit code, stdout and
stderr. JSON compares as data. Then it checks the 1.x-only commands: `init`, tokens, `serve`.

From pm 1.1 the contract for the CLI's output is a set of expected files, not 0.x (DD-024):

```sh
PMB_PG=postgres://pm_board:pm_board@localhost:5432/pm_board node tools/compare-cli.mjs --expected
PMB_PG=postgres://pm_board:pm_board@localhost:5432/pm_board node tools/compare-cli.mjs --update
```

`--expected` runs the same commands with `cli/bin/pm` only, and compares each command's exit code,
stdout and stderr with its file in `tools/fixtures/cli-expected/`. Each file is named after its
command (`list_--frontier.2.txt` is the second `pm list --frontier`), so a failure prints a diff
that names the command. The files mask what changes from run to run: a time or comment id made
during the run, the slug, the server URL, the temp folder, the CLI's version and Node's JSON.parse
message. JSON stdout is stored with sorted keys. It needs no 0.x. CI runs `--expected`; the comparison
with 0.x left CI with pm 1.1, whose help and exit codes differ from 0.x on purpose (DD-025).

A change of output needs a DD that says why. Make the change, run `--update`, read
`git diff tools/fixtures/cli-expected`, and commit the files with the code.

## Export to pm-data

```sh
cd server && dotnet run --project src/PmBoard.Api -- export ../out [--board <slug> ...]
```

`export` writes every board, or the ones named, as a 0.x board folder, `out/<slug>/`:
`pm.config.json`, `data/items` and `data/designs` as markdown with frontmatter, `data/plans`,
`data/sprints` and `data/milestones` as JSON, `data/archive`, the `*.tests.json` sidecars,
`attachments/` and `templates/` (DD-005, DD-022). 0.x can read it: `cd out/<slug> && pm list`. The
same data gives the same bytes, so an export with no change makes no commit. It reads one snapshot
and never writes into a folder that exists.

`tools/compare-export.mjs` checks it: it changes the fixture with awkward text, exports it, and
`compare-read.mjs` reads the export with 0.x's own code against the server. CI runs it.

## Routes

- `/api/health`: `{"ok": true}` when Postgres answers, 503 when it does not.
- `/api/boards`: every board, `{slug, name}`. POST `{slug, name}` creates an empty board with
  0.x's default config, for `pm init` (201, or 409 when the slug is taken; DD-021).
- `/api/boards/{slug}/...`: 0.x's read routes for that board, with the same JSON and filters:
  `config` (with `knowledgeBase` for the CLI), `items` (`type`, `stage`, `priority`, `sprintId`, `frontier`, `allClaims`),
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
  to run (DD-017). Each write needs a token (see Tokens).
- A body write never loses text (DD-030). PATCH on `items/{id}`, `designs/{id}` and
  `sprints/{id}` takes `bodyPrepend` and `bodyAppend`, which add a block in the update's
  transaction, one blank line from the body. `body` replaces the whole body: on a body with text it
  needs `bodyBase` (the `bodyHash` that `pm get` prints, the first 12 hex characters of the
  sha256 of the body) or `force: true`. A stale or missing base is 409 `{error, bodyHash}`, and
  nothing changes. A `bodyBase` that is not 12 hex characters is 400. A 0.x or 1.1 CLI sends
  no base, so it cannot replace a filled body.
- `/api/boards/{slug}/plans/{id}/next-task` and `/plans/{id}/context`: 0.x's two plan reads.
- `/api/boards/{slug}/tasks/{key}`: one task as it is inside its plan, with `planId`, for
  `pm get TASK-NNN` (DD-026). 0.x had no such route.
- `items`, `designs`, `plans` and `sprints` also take `sort=updatedAt` (oldest first, as pm list),
  `limit=N` (the newest N; the header `X-Total-Count` counts the rows before the cut) and
  `fields=id,title` (only those keys), so pm list downloads the rows it prints (DD-029). 0.x had
  none of them; without them the answer is 0.x's.
- `POST /api/boards/{slug}/glossary/match` `{"text": "..."}`: the terms the text mentions, the
  first match of each, by shared/glossary.js's rules, for the footer of `pm get` (DD-029). It
  changes nothing, so it needs no token. `node tools/compare-glossary.mjs <url> <slug>` checks it
  against the JS on every record of a board.
- `PUT /api/boards/{slug}/tests`: every sidecar tests list of the board, `{"tests": {"DD-003":
  [...]}}`, for a repo's test catalogue tool (DD-019).
- `POST /api/boards/{slug}/attachments?name=x.png` (the image is the body) and `GET` on the same
  path for the list. `/attachments/<name>` serves the file, as in 0.x (DD-018).
- `/api/boards/{slug}/events`: a server-sent event stream of changes, in 0.x's shape
  (`data: {"entity":"item","id":"SB-042","action":"update"}`). Postgres triggers send every change
  to a record or comment, from any writer, so the dashboard is never stale. A `resync` event asks
  the client to load the board again.
- `/api/...`: an unknown API path is 404, never the client. A request that is not a GET needs a
  token first, so there it is 401.
- Any other path serves the client, so `/<slug>` opens that board.

## Tokens

Every request that is not a GET or HEAD needs `Authorization: Bearer <token>` (DD-003, DD-020).
Without one, or with a wrong or revoked one, it gets 401 with `{"error": "..."}`. Reads need no
token, so the read-only dashboard works as before. Four POST routes change nothing and need no
token either: `sprints/{id}/suggest`, `sprints/{id}/explore`, `context/prompt` and
`context/review`.

Give each machine its own token, so you can revoke one without the others. The real tokens come
from the server in the cluster, so run the command in its pod:

```sh
kubectl -n pm-board exec deploy/pm-board -- dotnet PmBoard.Api.dll token create --user terje --name mac-mini
kubectl -n pm-board exec deploy/pm-board -- dotnet PmBoard.Api.dll token list
kubectl -n pm-board exec deploy/pm-board -- dotnet PmBoard.Api.dll token revoke <id>   # the whole id from token list
```

`token create` makes the user when it is new and prints the token on stdout, once. The server
keeps only its SHA-256 hash, so a lost token cannot be shown again: revoke it and make a new one.
Logs go to stderr, so `TOKEN=$(... token create ...)` gets the token alone. A user's tokens that
are not revoked must have different names.

A comment with no `author` records the token's user, where 0.x wrote `user`. A claim with no
`assignee` claims for the token's user, where 0.x refused it (DD-020).

For a local server (see Develop), run the same command with `dotnet run`. It uses the database in
the dev settings:

```sh
cd server && dotnet run --project src/PmBoard.Api -- token create --user terje --name dev
```

Put the token in the machine's pm config, `~/.config/pm/config.json` (`{"url": ..., "token": ...}`,
mode 600), not in a repo. `PM_TOKEN` overrides it.

## Deploy

CI pushes `ghcr.io/terjeballestad/pm-board:<commit sha>` on each push to `main`. The homelab repo
deploys it to k3s on VM 200 (`k8s/pm-board/`) at `pm.godstemning.dev`, on the tailnet only. To
release, change the image tag in `k8s/pm-board/deployment.yaml` in the homelab repo. ArgoCD does
the rest.

The server reads its database from `ConnectionStrings:pmboard`. In the cluster it comes from the
sealed secret `pm-board-db` as `ConnectionStrings__pmboard`. The server runs its EF Core
migrations at start.
