# 🦪 Clambake

A lite-JIRA board for tracking an **AI agent's** active / planned / done / testing-needed work
across any project. Built to fill the gaps when an agent runs a large, multi-step project:
it forgets parked work, loses where details landed, and re-digs whether tests passed.
Clambake gives that state a home you can see in your browser.

- **The agent** opens tickets (with acceptance criteria), moves them across the board, adds notes,
  links PRs — via a small CLI or by editing files.
- **You** watch it live in the browser: drag cards between columns, add notes, check off AC, add tickets,
  spot tickets that fell behind.
- Drops into **any** project — it's a standalone tool with no coupling to what it tracks.

![Clambake board](docs/board.png)

Click any card to open its detail — status, sprint, epic, acceptance criteria, markdown
test steps, screenshots, and notes:

<p align="center"><img src="docs/ticket.png" alt="Ticket detail" width="460"></p>

## Run

```bash
npm install
npm start
# open http://localhost:3000   (set PORT to change)
```

First run ships a **`demo`** project so the board isn't empty. Create your own with the
`+ Project` button or `node cli.js newproject <slug>`.

### Phone / other devices on your home network

The server binds all interfaces, so on startup it prints a `on your phone:` URL like
`http://192.168.1.x:3000` — open that on any device on the **same Wi-Fi**. This is
**LAN-only**: it's not reachable from the internet unless your router forwards a port.
There's no auth, so anyone on your network can view/edit — fine for a home network.

- Restrict back to this machine only: `HOST=127.0.0.1 npm start`.
- If a device can't connect, allow incoming connections for `node` in
  System Settings → Network → Firewall (if the firewall is on).

### Driving the CLI from another machine

By default `node cli.js …` edits the local data files, so it only works on the
machine that holds them. To drive the board from another computer on the LAN,
point the CLI at the host's server with `CLAMBAKE_URL` — every command then goes
over the REST API instead of touching disk:

```sh
# on the host
npm start                       # prints the http://192.168.1.x:3000 URL

# on any other machine (clambake checked out)
export CLAMBAKE_URL=http://192.168.1.x:3000
node cli.js ls     -p demo
node cli.js new    -p demo --title "Filed from my laptop"
node cli.js attach -p demo DEMO-1 ./screenshot.png    # uploads the local image
```

`attach` reads an image from the calling machine and uploads the bytes, so it
works the same whether the board is local or remote. Remove one with
`attach -p demo DEMO-1 rm <filename>`.

Same commands, same flags as local mode. Like the web UI, this has **no auth** —
anyone who can reach the port has full read/write, so keep it on a trusted network.

Most flags have short aliases (`-t`/`--title`, `-s`/`--status`, `-e`/`--epic`, …;
capitals for the siblings, `-T`/`--test-steps`, `-S`/`--sprint`, `-A`/`--assignee`).
A misspelled or value-less flag, or an invalid `--priority`/status, now fails with an
explanatory message (and a did-you-mean) instead of being silently ignored. Flags that
take markdown accept `@file` or `-` (stdin) so multi-line test steps don't need escaping:
`node cli.js update -p demo DEMO-1 -T @steps.md`.

## How it works

- **Source of truth = markdown files** under `data/projects/<slug>/tickets/<ID>.md`
  (YAML frontmatter for fields, body for notes). Human-readable, git-friendly.
- The server only reads/writes those files — no database. So edits the agent makes on disk
  and edits you make in the browser are the same data. The board **polls every ~4s**, so
  the agent's changes appear live.
- "Behind" is computed at read time: a non-`done` ticket is flagged ⚠ when its sprint ended,
  its due date passed, or it's gone untouched for `staleDays` (default 5, per `project.json`).
- **Data location** is `<repo>/data/projects` by default; set `CLAMBAKE_DATA` (absolute or
  relative) to keep the ticket store somewhere else — e.g. inside the project being tracked.

## Archiving finished work

Done tickets pile up. Set **`archiveDoneAfterDays`** in a project's `project.json` and
the board auto-archives a ticket that many days after it entered `done`:

```json
{ "name": "Demo", "idPrefix": "DEMO", "archiveDoneAfterDays": 2 }
```

- **Automatic** — the server sweeps on startup and every 10 minutes. Off by default
  (`null`), so nothing is archived unless you opt a project in.
- **Aged from `doneAt`** — the moment a ticket entered `done`, not its last edit, so a
  late note doesn't reset the clock. Tickets finished before this existed fall back to
  `updatedAt` (what the first sweep keys off).
- **Recoverable** — archiving *moves* the file to `data/projects/<slug>/archive/<ID>.md`;
  it leaves the board but isn't deleted. The board's **Archive** button lists archived
  tickets and restores any of them; **Run sweep now** forces a pass.
- **From the CLI** (works locally or over `CLAMBAKE_URL`):

```bash
node cli.js archive   -p demo            # sweep eligible done tickets now
node cli.js archive   -p demo --dry-run  # show what would move
node cli.js archive   -p demo --days 7   # one-off override of the threshold
node cli.js archive   -p demo DEMO-3     # archive one ticket explicitly
node cli.js archived  -p demo            # list archived tickets
node cli.js unarchive -p demo DEMO-3     # restore to the board
```

## Concurrency (you + the agent editing at once)

Two processes write the same files — your browser (→ server) and the agent (→ CLI). Safe because:

- **Atomic writes** — every write goes to a temp file then `rename`s over the target, so a
  concurrent reader sees the whole old or whole new file, never a torn half.
- **Per-ticket files** — edits to different tickets never collide.
- **Optimistic concurrency** — every mutating write sends the `updatedAt` snapshot it read;
  if the ticket changed underneath it, the save is rejected with a 409. The browser reloads the
  latest + toasts you to reapply; the **CLI exits non-zero with the conflict message so the
  caller can re-run** (it reads the ticket first, then writes with that stamp). No silent lost
  updates — including read-modify-write edits like `ac check`. (The stamp is millisecond-grained,
  so two writes landing in the same millisecond is the one residual gap.)
- **Exclusive create** (`O_EXCL`) — two simultaneous "new ticket" calls can't grab the same id;
  the loser retries with the next number.

## Event log

Every store mutation appends one structured line to `data/projects/<slug>/events.ndjson`
(gitignored — a runtime stream, not source of truth). Because both write paths funnel
through the store, this captures **every** change — local-CLI, browser, and remote-CLI
alike — as typed events: `created`, `moved`, `noted`, `edited`, `attached`,
`archived`, `unarchived`.

```json
{"ts":"2026-06-21T18:03:11.220Z","type":"moved","ticket":"DEMO-3","actor":"coder-1","from":"active","to":"done","epic":"Auth"}
```

Consumers (the watcher below) track a byte **offset** into the file as their cursor;
reads only consume whole lines, so a concurrent append is never seen half-parsed.

## Subscriptions & inbox (the notification system)

**There is one always-on notifier: the server.** Every write funnels through it, and it
fans each event into the inbox of every subscriber it matches. **Agents never start, run,
or restart a watcher** — they do exactly two things:

1. **`watch`** — register interest (once).
2. **`inbox`** — read what fanned out to them.

```bash
# 1. register interest (unions with whatever you already watch); needs --actor
node cli.js watch    -p demo --actor coder-2 --epic Auth --column done --ticket DEMO-3
node cli.js watch    -p demo --actor pm --mentions          # @pm in a note lands here

# 2. read your inbox — returns immediately with everything since you last read
node cli.js inbox    -p demo --actor coder-2                # drain (advances your cursor)
node cli.js inbox    -p demo --actor coder-2 --peek         # look without draining

node cli.js watching -p demo --actor coder-2                # show my subscription
node cli.js unwatch  -p demo --actor coder-2 --epic Auth    # drop one filter
node cli.js unwatch  -p demo --actor coder-2 --all          # stop watching entirely
```

`--epic` is **repeatable** — `--epic Auth --epic Billing` watches both (the comma form
`--epic Auth,Billing` also works). The same goes for `--ticket` and `--column`.

`inbox` has **no timeout and nothing to keep alive** — call it whenever your agent runs
(e.g. at the top of each turn) and you get everything accumulated since last time. The
inbox is cursor-tracked (durable, replay-safe — draining advances a cursor, nothing is
deleted). Subscriptions live in `data/projects/<slug>/watchers.json`. Matching is by
**ticket id**, **epic**, the **destination column** of a move (or a new ticket's column),
or an **@mention**. All commands work locally or over `CLAMBAKE_URL`.

**Tagging with @mentions.** Put `@actor` in a note (or a ticket body) and that actor gets
it in their inbox — **even if they never registered** — so you can tag the PM for a
decision without moving the ticket or owning a column:

```bash
node cli.js note -p demo DEMO-3 "@pm need a call on the schema change" --actor coder-1
node cli.js inbox -p demo --actor pm        # → DEMO-3: note — @pm need a call … (by coder-1)
```

An author is never pinged by their own `@self`, and a mention that also matches a
subscription is delivered just once.

### Push: get nudged instead of checking (`--notify`)

If you don't want to pull at all, register a **webhook**: the server fire-and-forgets a
`POST` to your URL the moment a matching event lands. Point it at your own listener, the
PM's harness, a Slack bridge — anything.

```bash
node cli.js watch -p demo --actor coder-2 --epic Auth --notify http://my-host:9000/wake
node cli.js watch -p demo --actor coder-2 --notify none      # turn the webhook off
```

The POST body is `{ project, actor, event }`. Delivery is **best-effort** — the **inbox
remains the source of truth**, so a missed push (listener down, network blip) is still
sitting in the inbox to pull. Pattern: webhook **nudges** you, then you `inbox` to drain.

> **The `--notify` URL is resolved by the *server* host, not your machine's localhost.**
> The server is what POSTs, so the host:port must be reachable *from the server*, and
> `localhost`/`127.0.0.1` means the server's own loopback. If several actors all register
> `http://localhost:9000/...`, their pushes collide into one receiver — use a **unique,
> server-reachable host:port per actor**, and have your receiver **ignore any POST whose
> `payload.actor` isn't you** (a cheap guard against cross-talk).

> Blocking option (`wait`): there's also `node cli.js wait --actor <id>` that blocks until
> events arrive. It's optional — for most turn-based agents `inbox` on your turn (or the
> webhook nudge) is simpler and has nothing to babysit. `watch.js` / `watch-loop.sh` are
> legacy whole-board tools; the inbox system above replaces them for per-agent use.

## Watcher (optional, for agent harnesses)

`watch.js` lets an agent/host harness block until the board changes, then re-run. It
tails the event log and exits on the first event — a move, a note, an edit, **anything**
(earlier versions diffed *status* and so missed notes/edits).

```bash
node watch.js <project> [--ignore-actor <id>] [--heartbeat-ms <n>] [--poll-ms <n>]
```

- `--ignore-actor <id>` — skip events whose `actor` is `<id>`, so an agent isn't woken by
  its own writes (pairs with the CLI `--actor` flag).
- `--heartbeat-ms <n>` — exit after `n` ms with no event (default 30 min) so the watch
  can't silently die.
- `--poll-ms <n>` — backstop poll interval (default 5s; `0` disables). `fs.watch` can miss
  appends, so the watcher also re-reads the log on this timer; a missed filesystem event
  is still caught within `n` ms.
- **Gap-safe:** it persists its log **offset** (`<project>/.watch_state.json`, gitignored)
  and resumes from it on start, so an event that lands between watches is still caught. A
  fresh watcher starts at end-of-log (ignores history).
- **Liveness:** on arm and every minute it writes `<project>/.watch_live.json` (pid,
  `armedAt`, `lastCheckAt`, all gitignored). A dead watcher and a quiet board otherwise
  look identical — a stale `lastCheckAt` means the watcher died and should be re-armed.

### Keeping the watcher alive across fires

`watch.js` is a one-shot edge detector: it **exits** on the first change so a turn-based
agent can react, which means something must re-arm it afterward. With many independent
sessions watching one board, a single missed re-arm silently blinds that session. The
`watch-loop.sh` supervisor closes that gap — it relaunches the watcher after every exit
and appends each fire to a wake log the agent tails, decoupling "watcher alive" from
"agent attentive":

```bash
# detached: keeps the watcher armed across turns; tail the wake log to see fires
nohup ./watch-loop.sh <project> --ignore-actor <id> >/dev/null 2>&1 &
tail -f ~/.clambake_wake_<project>.log
```

Because the watcher is gap-safe, the instant re-arm catches anything that landed during
the restart. The wake log's last `re-arming` line (UTC) doubles as the supervisor's own
liveness signal.

## Layout

```
server.js            HTTP API + serves the board
cli.js               agent/CLI entry point (node cli.js …)
watch.js             optional: tail a project's event log, exit on first change (for host harnesses)
watch-loop.sh        optional: supervisor that auto-re-arms watch.js after each fire
lib/schema.js        defaults, id allocation, behind logic
lib/store.js         file-backed read/write (emits events on every mutation)
lib/events.js        append-only event log: emit + cursor-based read
public/              the kanban UI (vanilla HTML/CSS/JS)
data/projects/<slug>/
  project.json       { name, idPrefix, staleDays, archiveDoneAfterDays, columns }
  sprints/<id>.md
  tickets/<ID>.md
  archive/<ID>.md    done tickets aged out of the board (recoverable)
  events.ndjson      append-only change stream (gitignored; what the watcher tails)
AGENTS.md            the contract an agent follows to drive the board
```

## For agents

See **[AGENTS.md](./AGENTS.md)** — when to open/move tickets and the full CLI cheat sheet —
and **[docs/agent-guide.md](./docs/agent-guide.md)** for the longer walkthrough (identity,
notifications, the agent loop, troubleshooting). Quick taste (run from the repo root):

```bash
node cli.js new  -p demo --title "Set up the board" --status planned --ac "columns defined"
node cli.js move -p demo DEMO-1 testingNeeded
node cli.js note -p demo DEMO-1 "PR #12 open, awaiting review"
node cli.js behind -p demo          # what fell behind
```

## Columns

Default: **Backlog · Planned · Active · Testing Needed · Done**.
Customize per project by editing the `columns` array in `data/projects/<slug>/project.json`.
