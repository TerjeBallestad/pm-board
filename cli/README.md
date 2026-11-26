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

## Change a body

A body write never loses text (DD-030, since pm 1.2). Several agents write the same records.

- To add a block, let the server do it: `pm patch SB-042 --prepend-body @block.md` puts it at the
  top, `--append-body` at the end, one blank line from the body. No read comes first, so no read
  can be stale. A superseding block (a correction that retires text below it) is a prepend.
- To replace the body, name the body you replace. `pm get SB-042` prints `bodyHash`, as does
  every read of one record (`pm issue SB-042`, `pm sdd <id>`, `pm project <id>`). Then
  `pm patch SB-042 --body @new.md --base <bodyHash>`. If someone changed the body since your
  read, the server refuses, pm prints the current hash on stderr and exits 3. Read it again and
  redo your change.
- `--force` replaces the body with no check. Use it only when you mean to throw away whatever is
  there.
- An empty body needs neither `--base` nor `--force`.

`pm sdd <id>` and `pm project <id>` take the same flags. `--body`, `--prepend-body` and
`--append-body` each read `@file` or `-` (stdin). Exit codes: 0 done, 1 error, 2 usage, 3 a body
write refused.

pm reads a value that starts with `--` as the next flag, so `--prepend-body "--- Superseded"`
stops with "needs a value". Put such a block in a file: `--prepend-body @block.md`.
