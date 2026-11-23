# pm 1.x

The `pm` command for a pm board server. It has the commands of pm 0.x, and since 1.1 it prints
less: reads print overviews, writes print one line, and `--json` gives the full answer as before
(DD-024 to DD-027). The board lives on one server, which gives out every
id, so two agents in two worktrees can never both make `SB-042`.

The 0.x line, with files in each repo, is `@terjeballestad/pm-board-cli@0`.

## Set up a machine

```sh
npm install -g @terjeballestad/pm-board-cli@1
mkdir -p ~/.config/pm
cat > ~/.config/pm/config.json <<'JSON'
{ "url": "https://pm.godstemning.dev", "token": "<this machine's token>" }
JSON
chmod 600 ~/.config/pm/config.json
```

Reads need no token. Every write does. `PM_URL` and `PM_TOKEN` override the file.

## Set up a repo

```sh
pm init my-repo          # creates the board, or links to it if it exists; writes .pm.json
git add .pm.json
```

`.pm.json` names the board: `{"board": "my-repo"}`. `pm` finds it from any subfolder or worktree.
`--board <slug>` uses another board for one command.

## Use

`pm help` lists the commands agents use, and `pm help <command>` gives one command's flags and
examples. The differences from 0.x are in DD-021: `init` makes a board on the server, `serve` and
`stop` are gone, `update` installs 1.x.

pm 1.1 removed `sweep`, `explore`, `suggest`, `review`, `plan-update`, `sdds`, `designs` and
`sprints`: each now names the command to use instead (DD-028). `issue`, `decision`, `concern`,
`gap`, `sdd`, `design`, `prompt`, `plans` and `sprint` still work, but the help leaves them out.
