# pm board

`pm` 1.x: one server that holds every project's board. Agents and people use the same `pm`
commands as in 0.x, and the server is the only place that gives out ids, so two agents in two
worktrees can never both make `SB-042`.

The 0.x line, the local-first edition with files in each repo, lives in
[pm-board-cli](https://github.com/TerjeBallestad/pm-board-cli).

The plan and the decisions are on the pm board: project SPRINT-001, PLAN-001, DD-001 to DD-006.

## Layout

```
server/   ASP.NET Core 10 minimal API, EF Core on Postgres (PmBoard.slnx)
client/   Vite + React + TypeScript dashboard, built into the API's wwwroot
```

`cli/` (the 1.x thin client) and `shared/` (the glossary) come in later tasks.

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

## Routes

- `/api/health`: `{"ok": true}` when Postgres answers, 503 when it does not.
- `/api/...`: an unknown API path is 404, never the client.
- Any other path serves the client, so `/<project>` opens that project's board.

## Deploy

CI pushes `ghcr.io/terjeballestad/pm-board:<commit sha>` on each push to `main`. The homelab repo
deploys it to k3s on VM 200 (`k8s/pm-board/`) at `pm.godstemning.dev`, on the tailnet only. To
release, change the image tag in `k8s/pm-board/deployment.yaml` in the homelab repo. ArgoCD does
the rest.

The server reads its database from `ConnectionStrings:pmboard`. In the cluster it comes from the
sealed secret `pm-board-db` as `ConnectionStrings__pmboard`. The server runs its EF Core
migrations at start.
