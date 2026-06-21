# Clambake — Agent & CLI User Guide

A practical guide for an **AI agent** (or a person) driving a clambake board from the
command line. If you just want the contract-level summary, see [AGENTS.md](../AGENTS.md);
this is the longer walkthrough.

---

## 1. Mental model

- A **board** belongs to a **project** (`-p <slug>`, e.g. `demo`).
- The board has **columns** (statuses): by default `backlog · planned · active · blocked ·
  testingNeeded · needsRework · done` (a project can customize these).
- A **ticket** is one unit of work. It has a status (which column it's in), a title,
  priority, an optional sprint and **epic** (a free-text grouping label), acceptance
  criteria (AC), markdown **test steps**, **notes** (a running log in the body), and
  **attachments** (images).
- **Source of truth is plain files** under `data/projects/<slug>/`. The CLI, the web UI,
  and the server all read/write the same markdown — your edits and a human's edits in the
  browser are the same data, and the browser polls so changes show up live.

You drive all of this with `node cli.js <command> -p <project> …`.

---

## 2. Identity: always pass `--actor`

Every write records **who did it** via `--actor <id>` (defaults to `ui`). Pick a stable id
for yourself (e.g. `coder-3`, `pm`, `reviewer`) and pass it on every command. It matters
because:

- Notifications skip your **own** actions (you won't be woken by your own writes).
- `@mentions` and inbox attribution use it.
- The board shows the last actor on each ticket.

```bash
node cli.js move -p demo DEMO-1 active --actor coder-3
```

---

## 3. Local vs remote (same commands either way)

- **Local** (default): the CLI edits the files directly on this machine.
- **Remote**: set `CLAMBAKE_URL` and every command goes over the LAN to a host's server
  instead — identical commands and flags.

```bash
export CLAMBAKE_URL=http://192.168.1.50:3000
node cli.js ls -p demo
```

There is **no authentication** — anyone who can reach the port has full read/write. Keep it
on a trusted network.

---

## 4. Flags, short forms, and loading long text

Most flags have a short alias. Lowercase is the common one; a Capital is its sibling when
the letter is taken:

| Short | Long | | Short | Long |
|---|---|---|---|---|
| `-p` | `--project` | | `-T` | `--test-steps` |
| `-t` | `--title` | | `-S` | `--sprint` |
| `-s` | `--status` | | `-A` | `--assignee` |
| `-a` | `--actor` | | `-e` | `--epic` |
| `-i` | `--id` | | `-l` | `--label` |
| `-d` | `--due` | | | |

**Loading markdown without escaping.** Any text flag accepts `@file` (read from a file) or
`-` (read from stdin) — ideal for multi-line test steps. Use `@@` for a literal leading `@`.

```bash
node cli.js new -p demo -t "Login flow" -T @steps.md
echo "$STEPS" | node cli.js update -p demo DEMO-1 -T -
```

**Invalid args fail loudly.** A misspelled flag, a missing value, or a bad
`--priority`/status no longer gets silently dropped:

```
$ node cli.js new -p demo --titel Oops
error: unknown flag --titel. Did you mean --title?

$ node cli.js move -p demo DEMO-1 dones
error: invalid status "dones" for demo. valid columns: backlog, planned, active, blocked, testingNeeded, needsRework, done
```

---

## 5. Command reference

### Create & read

```bash
# create — --ac/--label/--link repeat
node cli.js new -p demo -t "Results screen" -s planned \
  -S sprint-1 -e results --priority high -a coder-3 \
  --ac "shows score" --ac "replay button" --label ui --link <pr-url>

node cli.js ls     -p demo                 # the board as text
node cli.js ls     -p demo --status active # filter by column
node cli.js ls     -p demo --behind        # only tickets that fell behind
node cli.js show   -p demo DEMO-1          # full ticket JSON
node cli.js behind -p demo                 # what fell behind — check this often
node cli.js projects                       # list projects
```

### Move, edit, notes

```bash
node cli.js move   -p demo DEMO-1 testingNeeded -a coder-3
node cli.js update -p demo DEMO-1 --priority high -S sprint-1 --due 2026-07-01 -a coder-3
node cli.js update -p demo DEMO-1 -e results          # set epic ( --epic none to clear )
node cli.js update -p demo DEMO-1 -T @steps.md        # replace test steps from a file
node cli.js note   -p demo DEMO-1 "PR #12 open, awaiting review" -a coder-3
```

### Acceptance criteria

```bash
node cli.js ac -p demo DEMO-1 add "handles empty score"
node cli.js ac -p demo DEMO-1 check 0     # tick AC index 0 (uncheck to undo)
```

### Attachments (images)

```bash
node cli.js attach -p demo DEMO-1 ./screenshot.png          # uploads the bytes (works remote too)
node cli.js attach -p demo DEMO-1 rm screenshot.png         # remove one
```

### Archive (aging out done tickets)

```bash
node cli.js archive   -p demo            # sweep eligible done tickets now
node cli.js archive   -p demo --dry-run  # show what would move
node cli.js archive   -p demo DEMO-3     # archive one explicitly
node cli.js archived  -p demo            # list archived
node cli.js unarchive -p demo DEMO-3     # restore to the board
```

### Sprints & projects

```bash
node cli.js sprint new   -p demo --id sprint-2 --name "Sprint 2" --end 2026-07-15 --goal "…"
node cli.js sprint close -p demo sprint-1
node cli.js newproject demo2 --name "Demo 2" --prefix DM2
```

---

## 6. Getting notified (the important part)

You rarely want to re-read the whole board. Instead, **register interest** and let changes
come to you. Under the hood every mutation emits an event; the system fans matching events
into your personal inbox.

### Subscribe to what you care about

```bash
node cli.js watch -p demo --actor coder-3 --ticket DEMO-3   # one ticket
node cli.js watch -p demo --actor coder-3 --epic results    # a whole epic
node cli.js watch -p demo --actor coder-3 --column done     # anything entering a column
node cli.js watch -p demo --actor coder-3 --epic A --epic B # repeatable: watch both epics
```

`--epic` is **repeatable** (`--epic A --epic B`), and the comma form `--epic A,B` still
works too — same for `--ticket` and `--column`.

`watch` unions with whatever you already watch. Inspect or remove:

```bash
node cli.js watching -p demo --actor coder-3
node cli.js unwatch  -p demo --actor coder-3 --epic results   # drop one filter
node cli.js unwatch  -p demo --actor coder-3 --all            # stop entirely
```

### Read your inbox

```bash
node cli.js inbox -p demo --actor coder-3          # drain new events (advances your cursor)
node cli.js inbox -p demo --actor coder-3 --peek   # look without draining
```

The inbox is durable and replay-safe: draining only advances a cursor, nothing is deleted.
It returns immediately — **no timeout, nothing to keep alive.** Read it whenever your agent
runs (typically the first thing each turn) and you get everything since last time. You never
start or restart a watcher; the server is the always-on notifier.

### Get pushed instead of checking (`--notify`)

If you'd rather be nudged than pull, register a webhook. The server fire-and-forgets a
`POST {project, actor, event}` to your URL the instant a matching event lands:

```bash
node cli.js watch -p demo --actor coder-3 --epic results --notify http://my-host:9000/wake
node cli.js watch -p demo --actor coder-3 --notify none     # turn it off
```

Push is **best-effort** — the inbox stays the source of truth, so a missed nudge is still
there to pull. Pattern: webhook wakes you → you `inbox` to drain.

**The `--notify` URL is resolved by the *server* host, not your machine.** The server is
what sends the POST, so `localhost`/`127.0.0.1` is the server's own loopback — if multiple
actors all register `http://localhost:9000/...`, every push collides into the same receiver.
Use a **unique, server-reachable host:port per actor**, and have your receiver **ignore any
POST whose `payload.actor` isn't you**.

### Optional: block with `wait`

If you specifically want to block in a script until something arrives, `wait` does that
(any `--timeout` length is safe). It's optional — for most turn-based agents `inbox` on your
turn, or the webhook nudge, is simpler with nothing to babysit.

```bash
node cli.js wait -p demo --actor coder-3 --timeout 120000
```

### Tag someone with `@mentions`

Put `@actor` in a note (or a ticket body) and it lands in **their** inbox — even if they
never registered. This is how you pull in the PM for a decision **without** moving the
ticket into a PM column:

```bash
node cli.js note -p demo DEMO-3 "@pm need a call on the schema change" -a coder-3
# → in pm's inbox: DEMO-3: note — @pm need a call on the schema change (by coder-3)
```

You're never pinged by your own `@self`, and an event that both mentions you and matches a
subscription is delivered once.

### Whole-board watching (legacy / harness use)

`watch.js` (and its `watch-loop.sh` supervisor) tail the whole event log and exit on the
first change — a host-harness tool that predates the inbox. For per-agent notifications use
`watch` + `inbox` (+ optional `--notify`) above; you don't need to run or supervise anything.

---

## 7. A recommended agent loop

Register once, then **read your inbox each time you run** — no watcher, no timeout:

```bash
ME=coder-3
node cli.js watch -p demo --actor $ME --epic my-epic   # set up once (@mentions reach you regardless)

# ...then at the top of every turn:
node cli.js inbox -p demo --actor $ME                   # what changed since last turn
# For each event: pick up the ticket, do the work, then report:
node cli.js move -p demo DEMO-7 active        -a $ME
node cli.js note -p demo DEMO-7 "PR #34 open" -a $ME
node cli.js move -p demo DEMO-7 testingNeeded -a $ME
```

If your harness leaves an agent idle and you want clambake to **wake** it event-driven, add
`--notify <url>` to the `watch` and have your supervisor hit that URL → run the agent → it
drains `inbox`. (A standalone script that must block in place can use `wait` instead.)

Etiquette:
- Open a ticket before starting non-trivial work; move it as its state changes.
- Leave a **note** at decision points and when you hand off (where the PR is, what's
  blocked, what you decided) — future-you and the human read these.
- Keep AC honest; check items as they're truly done.
- Tag the right person with `@mention` instead of parking a ticket in someone's column.

---

## 8. Concurrency & troubleshooting

- **Conflicts (409).** Mutations send the `updatedAt` snapshot they read; if the ticket
  changed underneath you, the write is rejected and the CLI exits non-zero with a conflict
  message. **Re-run** the command (re-read, reapply) — it's a retry signal, not a failure.
- **Invalid arguments.** See §4 — the error names the problem and suggests a fix.
- **`(inbox empty)` / `(no new events)`.** Nothing matched your subscription since your last
  drain. Confirm with `watching`, and remember you don't get your own actions.
- **Remote can't connect.** Check `CLAMBAKE_URL`, that the host's server is up, and that the
  port is reachable on the LAN.

---

## See also

- [AGENTS.md](../AGENTS.md) — the short contract + cheat sheet.
- [README.md](../README.md) — running the server, the web UI, data layout, and internals
  (event log, subscriptions, watcher).
