# Clambake — the contract for agents

Clambake is a lite-JIRA board so a human can see your active/planned/done/testing work
and so **you don't lose parked work, forget where details landed, or re-dig whether tests passed.**
Treat it as your durable, shared scratchpad for project state.

**Source of truth = markdown files** under `data/projects/<project>/tickets/<ID>.md`.
You can change state two ways:

1. **`node cli.js …`** — the safe default (handles id allocation, `updatedAt` bumps, validation).
2. **Editing the `.md` file directly** with your normal file tools — fine for bulk/body edits.
   The server re-reads files on every request, so hand-edits appear on the board within ~4s.

Run all commands from the clambake repo root (or use an absolute path to `cli.js`). The data dir
is `<repo>/data/projects` unless `CLAMBAKE_DATA` is set.

## When to open / move a ticket

- **Open a ticket** the moment you commit to a piece of work OR park something for later.
  Put the acceptance criteria (AC) on it so "done" is unambiguous.
- **Move it** as reality changes — don't batch this up; the board is only useful if it's live:
  - `backlog` → not started, unscheduled
  - `planned` → scheduled into a sprint, not yet started
  - `active` → being worked right now
  - `blocked` → can't proceed (waiting on a dep/decision) — note WHY in the body
  - `testingNeeded` → work landed but needs a test / verification / human playtest before it's trusted
  - `needsRework` → testing/review bounced it back — fix required; note WHAT failed in the body
  - `done` → AC met **and** verified. Only `done` clears the "behind" flag.
- **Append a note** whenever you park, hit a blocker, or learn where something landed:
  `node cli.js note -p <project> <id> "Parked: blocked on X; details in PR #88"`.
  Future-you reads these instead of re-digging.
- **Link the PR/doc/CI** onto the ticket so the human (and you) can jump straight there.

## Cheat sheet

```bash
# create — AC/label/link flags repeat
node cli.js new -p demo --title "Results screen" --status planned \
  --sprint sprint-1 --epic results-screen --priority high --assignee coder \
  --ac "shows score" --ac "replay button" --label ui --link <pr-url>

node cli.js move   -p demo DEMO-1 blocked        # columns: backlog planned active blocked testingNeeded needsRework done
node cli.js note   -p demo DEMO-1 "PR #12 open, awaiting review"
node cli.js update -p demo DEMO-1 --test-steps "## Steps
1. Open X
2. Click Y

**Expected:** Z"        # markdown; rendered for the human. --test-steps none to clear
node cli.js ac     -p demo DEMO-1 add "handles empty score"
node cli.js ac     -p demo DEMO-1 check 0      # tick AC index 0 (uncheck = uncheck)
node cli.js update -p demo DEMO-1 --priority high --sprint sprint-1 --due 2026-07-01
node cli.js update -p demo DEMO-1 --epic results-screen     # loose group; --epic none to clear

node cli.js ls     -p demo                      # read the board back as text
node cli.js ls     -p demo --status active      # filter
node cli.js behind -p demo                      # what fell behind — check this often
node cli.js show   -p demo DEMO-1               # full ticket JSON (incl. behind flag)
node cli.js projects                            # list projects
node cli.js newproject <slug> --name "…" --prefix ABC   # new project

node cli.js sprint new   -p <project> --id sprint-2 --name "Sprint 2" --end 2026-07-15 --goal "…"
node cli.js sprint edit  -p <project> sprint-2 --name "…" --start … --end … --goal "…"
node cli.js sprint close -p <project> sprint-1
node cli.js sprint rm    -p <project> sprint-2   # deletes sprint; unassigns its tickets
node cli.js sprint ls    -p <project>
```

## Conventions & gotchas

- **AC shape** in frontmatter: `ac: [{ text: "...", done: false }]`. Use `cli.js ac` to avoid hand-writing it.
- **`update --link` / `--label` REPLACE** the whole list (pass all values you want to keep).
  To *append* a single link/note without losing existing ones, prefer the web modal or `cli.js note`,
  or edit the `.md` directly.
- **"Behind" is computed, not stored.** A non-`done` ticket flags as behind when its sprint's
  `endDate` has passed, its own `dueDate` passed, or it's been untouched ≥ `staleDays`
  (default 5, set in `project.json`). Moving it to `done` or touching it clears the flag.
- **Set `sprint: none`** via `update --sprint none` to unschedule.
- **Epic** is a free-text loose grouping link (no separate entity) — cards sort/cluster by it and
  it has its own board filter. Reuse the same string across related tickets; `--epic none` clears it.
- **Test steps** (`testSteps`) is markdown (raw HTML allowed) rendered for the human on the ticket —
  put clear Setup / Steps / Expected here for anything Chuck must verify. Multi-line is fine via
  `--test-steps "..."` or by editing the `.md` (it stores as a YAML block scalar).
- **Concurrency:** your CLI writes always win (no optimistic-concurrency check) — just fire them.
  The human's browser is the side that gets a "reload, it changed" prompt, not you.
- **Identify yourself with `--actor <id>`** on every write (`new`/`move`/`update`/`ac`/`note`) so the
  ticket records who touched it last (frontmatter `lastActor`). Omitting it defaults to `ui`
  (board/human). E.g. `node cli.js move -p <project> TICK-12 done --actor pm`.
- One project per `data/projects/<slug>/`; tickets and sprints are isolated per project.
