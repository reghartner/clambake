#!/usr/bin/env node
// Clambake CLI — the safe write path for Claude / agents.
// Wraps lib/store.js so agents get id allocation, updatedAt bumps, and
// frontmatter validation without hand-authoring YAML.
//
// By default it edits the local data files. Set CLAMBAKE_URL to drive a remote
// board over the LAN instead — every command then hits that server's REST API:
//   CLAMBAKE_URL=http://192.168.1.50:3000 node cli.js ls -p demo
//
//   node cli.js new    -p <proj> --title "..." [--status planned] [--sprint s1]
//                      [--priority high] [--ac "..."]... [--label x]... [--link url]... [--assignee a]
//   node cli.js move   -p <proj> <id> <status>
//   node cli.js update -p <proj> <id> [--title ...] [--priority ...] [--sprint ...]
//                      [--link url]... [--label x]... [--assignee a] [--due 2026-07-01]
//   node cli.js ac     -p <proj> <id> add "criterion"     | check <index> | uncheck <index>
//   node cli.js note   -p <proj> <id> "free text note"
//   node cli.js attach -p <proj> <id> <image-path> [--name name] | rm <filename>
//   node cli.js ls     -p <proj> [--status active] [--sprint s1] [--behind]
//   node cli.js show   -p <proj> <id>
//   node cli.js behind -p <proj>
//   node cli.js rm     -p <proj> <id>
//   node cli.js archive   -p <proj> [<id>] [--days N] [--dry-run]   sweep, or archive one
//   node cli.js archived  -p <proj>                                 list archived tickets
//   node cli.js unarchive -p <proj> <id>                            restore to the board
//   node cli.js watch    -p <proj> --actor <id> [--ticket ID]... [--epic E]... [--column C]... [--mentions] [--notify <url>]
//   node cli.js unwatch  -p <proj> --actor <id> [--ticket ID]... [--epic E]... | [--all]
//   node cli.js watching -p <proj> --actor <id>           show this actor's subscription
//   node cli.js inbox    -p <proj> --actor <id> [--peek]  drain new events for this actor
//   node cli.js wait     -p <proj> --actor <id> [--timeout ms]  block until new events, then print
//   node cli.js projects
//   node cli.js newproject <slug> [--name "..."] [--prefix MET] [--stale 5]
//   node cli.js sprint new -p <proj> --id s1 --name "Sprint 1" [--start ...] [--end ...] [--goal ...]
//   node cli.js sprint close -p <proj> <id>
//
// Short flags:  -p project  -t title  -s status  -S sprint  -e epic  -a actor
//               -A assignee  -d due  -i id  -l label  -T test-steps
// Long-value loading: any text flag taking markdown (esp. -T/--test-steps) accepts
//   -T @file   (read from a file)   or   -T -   (read from stdin)   so multi-line
//   test steps don't need shell-escaping. Use @@ for a literal leading '@'.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { makeClient } from "./lib/api-client.js";
import { PRIORITIES } from "./lib/schema.js";

// Set CLAMBAKE_URL=http://<host>:3000 to drive a remote board over the LAN;
// otherwise read/write the local data files directly (the original behavior).
// The HTTP client is async, the local store is sync — every call site awaits,
// which is a no-op on plain return values.
const store = process.env.CLAMBAKE_URL
  ? makeClient(process.env.CLAMBAKE_URL)
  : await import("./lib/store.js");

const argv = process.argv.slice(2);
const cmd = argv[0];

// Generic flag parser. Repeatable flags (ac/label/link) collect into arrays.
function parse(args, { multi = [] } = {}) {
  // Short aliases: lowercase = the most-used flag, Capital = its sibling when the
  // lowercase letter is already taken (e.g. -t title / -T test-steps, -s status /
  // -S sprint, -a actor / -A assignee). Agents kept tripping over -t vs --title.
  const options = {
    p: { type: "string", short: "p" },
    project: { type: "string" },
    title: { type: "string", short: "t" },
    status: { type: "string", short: "s" },
    sprint: { type: "string", short: "S" },
    // repeatable so `watch --epic A --epic B` registers both; new/update take the last.
    epic: { type: "string", short: "e", multiple: true },
    priority: { type: "string" },
    assignee: { type: "string", short: "A" },
    due: { type: "string", short: "d" },
    "test-steps": { type: "string", short: "T" },
    actor: { type: "string", short: "a" },
    id: { type: "string", short: "i" },
    name: { type: "string" },
    prefix: { type: "string" },
    stale: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    goal: { type: "string" },
    behind: { type: "boolean" },
    days: { type: "string" },
    "dry-run": { type: "boolean" },
    ac: { type: "string", multiple: true },
    label: { type: "string", short: "l", multiple: true },
    link: { type: "string", multiple: true },
    // watch subscriptions + inbox
    ticket: { type: "string", multiple: true },
    column: { type: "string", multiple: true },
    mentions: { type: "boolean" },
    all: { type: "boolean" },
    peek: { type: "boolean" },
    timeout: { type: "string" },
    notify: { type: "string" },
  };
  let parsed;
  try {
    // strict: an unknown/misspelled flag is an ERROR, not silently dropped — so a
    // typo'd --titel no longer creates a ticket with no title and no warning.
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    die(parseErrorMessage(e, options));
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

// Turn a parseArgs failure into actionable feedback: name the bad flag, suggest the
// closest real one, and list what's valid.
function parseErrorMessage(e, options) {
  const longs = Object.keys(options).filter((k) => k !== "p"); // 'p' is the -p alias of project
  const flagList = longs
    .map((k) => (options[k].short ? `--${k}/-${options[k].short}` : `--${k}`))
    .join(", ");
  const raw = (e.message.match(/'(-{1,2}[^']+)'/) || [])[1];
  const bad = raw ? raw.split(/[ ,]/)[0] : null; // node sometimes echoes "-t, --title <value>"
  if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && bad) {
    // Only did-you-mean for long flags — guessing a long name from a one-char short is noise.
    const guess = bad.startsWith("--") ? closest(bad.replace(/^-+/, ""), longs) : null;
    const hint = guess ? ` Did you mean --${guess}?` : "";
    return `unknown flag ${bad}.${hint}\nvalid flags: ${flagList}`;
  }
  if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && bad) {
    return `flag ${bad} needs a value (e.g. ${bad} <value>).\nvalid flags: ${flagList}`;
  }
  return `${e.message}\nvalid flags: ${flagList}`;
}

// Nearest known flag by edit distance (only if reasonably close), for did-you-mean.
function closest(word, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= Math.max(2, Math.ceil(word.length / 3)) ? best : null;
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[a.length][b.length];
}

function proj(values) {
  const p = values.p || values.project;
  if (!p) die("Missing -p <project>");
  return p;
}

// A flag may now be repeatable (parseArgs gives an array). Where a single value is wanted
// (a ticket has one epic), take the last one given.
function scalar(v) {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

// Normalize a repeatable/comma flag into a flat list: undefined | "a,b" | ["a","b,c"] -> [...].
function asList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
}

// One-line render of a subscription.
function fmtSub(sub) {
  if (!sub) return "nothing";
  const parts = [];
  if (sub.tickets?.length) parts.push(`tickets=[${sub.tickets.join(",")}]`);
  if (sub.epics?.length) parts.push(`epics=[${sub.epics.join(",")}]`);
  if (sub.columns?.length) parts.push(`columns=[${sub.columns.join(",")}]`);
  if (sub.mentions) parts.push("@mentions");
  if (sub.notify) parts.push(`→ ${sub.notify}`);
  return parts.join(" ") || "nothing";
}

// One-line render of an inbox/event entry.
function fmtEvent(e) {
  const t = e.ts ? e.ts.slice(11, 19) : "--:--:--";
  const who = e.actor ? ` (by ${e.actor})` : "";
  switch (e.type) {
    case "moved":
      return `${t}  ${e.ticket}: ${e.from} -> ${e.to}${who}`;
    case "created":
      return `${t}  ${e.ticket}: created [${e.status}] ${e.title || ""}`.trimEnd() + who;
    case "noted":
      return `${t}  ${e.ticket}: note${e.summary ? ` — ${e.summary}` : ""}${who}`;
    case "edited":
      return `${t}  ${e.ticket}: edited ${(e.fields || []).join(", ")}${who}`;
    default:
      return `${t}  ${e.ticket}: ${e.type}${who}`;
  }
}

// Enum-value guards: reject a bad --priority / status with the valid set, instead of
// silently writing a ghost value the board can't display.
function checkPriority(v) {
  if (v != null && !PRIORITIES.includes(v)) die(`invalid --priority "${v}". valid: ${PRIORITIES.join(", ")}`);
}
async function checkStatus(slug, v) {
  if (v == null) return;
  const { project } = await store.getBoard(slug);
  const ids = (project?.columns || []).map((c) => c.id);
  if (!ids.length) return; // columns unknown (e.g. minimal remote) — can't validate, don't block
  if (!ids.includes(v)) die(`invalid status "${v}" for ${slug}. valid columns: ${ids.join(", ")}`);
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// Resolve a string flag that may load from a file or stdin instead of being inline.
// Lets agents pass multi-line markdown (e.g. test steps) without shell-escaping it:
//   -T @steps.md   reads the file        -T -   reads stdin
// A literal leading '@' can be escaped as '@@'.
function loadText(v) {
  if (v == null) return v;
  if (v === "-") return readFileSync(0, "utf8");
  if (v.startsWith("@@")) return v.slice(1);
  if (v.startsWith("@")) {
    try {
      return readFileSync(v.slice(1), "utf8");
    } catch (e) {
      die(`cannot read ${v.slice(1)}: ${e.message}`);
    }
  }
  return v;
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function fmtTicket(t) {
  const acDone = t.ac.filter((a) => a.done).length;
  const flags = [];
  if (t.behind) flags.push(`⚠ ${t.behindReason}`);
  const head = `${t.id}  [${t.status}]  ${t.title}`;
  const meta = [
    `pri=${t.priority}`,
    t.sprint ? `sprint=${t.sprint}` : null,
    t.ac.length ? `ac=${acDone}/${t.ac.length}` : null,
    t.assignee ? `@${t.assignee}` : null,
    flags.length ? flags.join(" ") : null,
  ]
    .filter(Boolean)
    .join("  ");
  return meta ? `${head}\n    ${meta}` : head;
}

try {
  switch (cmd) {
    case "new": {
      const { values } = parse(argv.slice(1));
      checkPriority(values.priority);
      await checkStatus(proj(values), values.status);
      const t = await store.createTicket(
        proj(values),
        {
          title: values.title,
          status: values.status,
          sprint: values.sprint,
          epic: scalar(values.epic),
          priority: values.priority,
          assignee: values.assignee,
          dueDate: values.due,
          testSteps: loadText(values["test-steps"]),
          labels: values.label,
          links: values.link,
          ac: values.ac,
        },
        values.actor || "ui"
      );
      console.log(`created ${t.id}`);
      break;
    }

    case "move": {
      const { values, positionals } = parse(argv.slice(1));
      const [id, status] = positionals;
      if (!id || !status) die("usage: move -p <proj> <id> <status>");
      await checkStatus(proj(values), status);
      // Send the snapshot we read so a concurrent write is rejected with 409
      // rather than silently clobbered — the caller re-runs to retry.
      const before = await store.getTicket(proj(values), id);
      const t = await store.updateTicket(proj(values), id, { status, expectedUpdatedAt: before.updatedAt }, values.actor || "ui");
      console.log(`${t.id} -> ${t.status}`);
      break;
    }

    case "update": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (!id) die("usage: update -p <proj> <id> [flags]");
      checkPriority(values.priority);
      await checkStatus(proj(values), values.status);
      const patch = {};
      if (values.title != null) patch.title = values.title;
      if (values.status != null) patch.status = values.status;
      if (values.sprint != null) patch.sprint = values.sprint === "none" ? null : values.sprint;
      // --epic is repeatable (array); a ticket has one epic, so take the last given.
      if (values.epic != null) {
        const e = scalar(values.epic);
        patch.epic = e === "none" ? "" : e;
      }
      if (values.priority != null) patch.priority = values.priority;
      if (values.assignee != null) patch.assignee = values.assignee;
      if (values.due != null) patch.dueDate = values.due === "none" ? null : values.due;
      if (values["test-steps"] != null) patch.testSteps = values["test-steps"] === "none" ? "" : loadText(values["test-steps"]);
      if (values.label) patch.labels = values.label;
      if (values.link) patch.links = values.link;
      // Optimistic-concurrency: reject (409) if the ticket moved under us.
      const before = await store.getTicket(proj(values), id);
      patch.expectedUpdatedAt = before.updatedAt;
      const t = await store.updateTicket(proj(values), id, patch, values.actor || "ui");
      console.log(`updated ${t.id}`);
      break;
    }

    case "ac": {
      const { values, positionals } = parse(argv.slice(1));
      const [id, sub, arg] = positionals;
      if (!id || !sub) die('usage: ac -p <proj> <id> add "text" | check <i> | uncheck <i>');
      const current = await store.getTicket(proj(values), id);
      const ac = current.ac.slice();
      if (sub === "add") {
        if (!arg) die("ac add needs text");
        ac.push({ text: arg, done: false });
      } else if (sub === "check" || sub === "uncheck") {
        const i = parseInt(arg, 10);
        if (!ac[i]) die(`no AC at index ${i}`);
        ac[i] = { ...ac[i], done: sub === "check" };
      } else {
        die(`unknown ac subcommand: ${sub}`);
      }
      // This is a read-modify-write on the ac array; pass the snapshot's stamp so
      // a concurrent edit is rejected (409) instead of silently lost.
      await store.updateTicket(proj(values), id, { ac, expectedUpdatedAt: current.updatedAt }, values.actor || "ui");
      console.log(`${id} ac updated (${ac.filter((a) => a.done).length}/${ac.length})`);
      break;
    }

    case "note": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      const text = positionals.slice(1).join(" ");
      if (!id || !text) die('usage: note -p <proj> <id> "text"');
      const before = await store.getTicket(proj(values), id);
      await store.appendNote(proj(values), id, text, before.updatedAt, values.actor || "ui");
      console.log(`note added to ${id}`);
      break;
    }

    case "attach": {
      const { values, positionals } = parse(argv.slice(1));
      const [id, sub, arg] = positionals;
      if (!id) die("usage: attach -p <proj> <id> <image-path> [--name name]  |  attach -p <proj> <id> rm <filename>");
      if (sub === "rm") {
        if (!arg) die("attach rm needs a filename");
        await store.removeAttachment(proj(values), id, arg, values.actor || "ui");
        console.log(`removed ${arg} from ${id}`);
        break;
      }
      if (!sub) die("attach needs an image path");
      let buffer;
      try {
        buffer = readFileSync(sub);
      } catch (e) {
        die(`cannot read ${sub}: ${e.message}`);
      }
      const name = values.name || basename(sub);
      const r = await store.addAttachment(proj(values), id, name, buffer, values.actor || "ui");
      console.log(`attached ${r.filename} to ${id}`);
      break;
    }

    case "archive": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (id) {
        await store.archiveTicket(proj(values), id);
        console.log(`archived ${id}`);
        break;
      }
      const days = values.days != null ? Number(values.days) : undefined;
      const r = await store.sweepArchive(proj(values), { days, dryRun: !!values["dry-run"] });
      if (values["dry-run"]) {
        console.log(r.eligible.length ? `would archive: ${r.eligible.join(", ")}` : "nothing eligible");
      } else {
        console.log(r.archived.length ? `archived: ${r.archived.join(", ")}` : "nothing to archive");
      }
      break;
    }

    case "archived": {
      const { values } = parse(argv.slice(1));
      const list = await store.listArchived(proj(values));
      if (!list.length) {
        console.log("(no archived tickets)");
        break;
      }
      for (const t of list) console.log(`${t.id}  ${t.title}  (done ${t.doneAt ? t.doneAt.slice(0, 10) : "?"})`);
      break;
    }

    case "unarchive": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (!id) die("usage: unarchive -p <proj> <id>");
      await store.unarchiveTicket(proj(values), id);
      console.log(`unarchived ${id}`);
      break;
    }

    case "ls": {
      const { values } = parse(argv.slice(1));
      const { tickets } = await store.getBoard(proj(values));
      let list = tickets;
      if (values.status) list = list.filter((t) => t.status === values.status);
      if (values.sprint) list = list.filter((t) => t.sprint === values.sprint);
      if (values.behind) list = list.filter((t) => t.behind);
      if (!list.length) {
        console.log("(no tickets)");
        break;
      }
      for (const t of list) console.log(fmtTicket(t));
      break;
    }

    case "show": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (!id) die("usage: show -p <proj> <id>");
      const { tickets } = await store.getBoard(proj(values));
      const t = tickets.find((x) => x.id === id);
      if (!t) die(`no such ticket: ${id}`);
      out(t);
      break;
    }

    case "behind": {
      const { values } = parse(argv.slice(1));
      const { tickets } = await store.getBoard(proj(values));
      const list = tickets.filter((t) => t.behind);
      if (!list.length) {
        console.log("nothing behind 🎉");
        break;
      }
      for (const t of list) console.log(fmtTicket(t));
      break;
    }

    case "rm": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (!id) die("usage: rm -p <proj> <id>");
      await store.deleteTicket(proj(values), id);
      console.log(`deleted ${id}`);
      break;
    }

    case "projects": {
      const list = await store.listProjects();
      if (!list.length) console.log("(no projects)");
      for (const p of list) console.log(`${p.slug}  (${p.name})  prefix=${p.idPrefix} stale=${p.staleDays}d`);
      break;
    }

    case "newproject": {
      const { values, positionals } = parse(argv.slice(1));
      const slug = positionals[0];
      if (!slug) die("usage: newproject <slug> [--name ...] [--prefix MET] [--stale 5]");
      const p = await store.createProject({
        slug,
        name: values.name,
        idPrefix: values.prefix,
        staleDays: values.stale != null ? Number(values.stale) : undefined,
      });
      console.log(`created project ${p.slug}`);
      break;
    }

    case "watch": {
      // Register interest so matching events land in this actor's inbox.
      const { values } = parse(argv.slice(1));
      const actor = values.actor || die("watch needs --actor <id>");
      const filters = {
        tickets: asList(values.ticket),
        epics: asList(values.epic),
        columns: asList(values.column),
        mentions: !!values.mentions,
      };
      if (values.notify != null) filters.notify = values.notify; // webhook push URL (or "none" to clear)
      const hasFilter = filters.tickets.length || filters.epics.length || filters.columns.length || filters.mentions;
      if (!hasFilter && values.notify == null) {
        die("watch needs at least one of --ticket --epic --column --mentions (or --notify <url>)");
      }
      const sub = await store.setWatch(proj(values), actor, filters);
      console.log(`${actor} now watching ${fmtSub(sub)}`);
      break;
    }

    case "unwatch": {
      const { values } = parse(argv.slice(1));
      const actor = values.actor || die("unwatch needs --actor <id>");
      const sub = await store.unwatch(proj(values), actor, {
        tickets: asList(values.ticket),
        epics: asList(values.epic),
        columns: asList(values.column),
        mentions: !!values.mentions,
        all: !!values.all,
      });
      console.log(sub ? `${actor} now watching ${fmtSub(sub)}` : `${actor} is no longer watching anything`);
      break;
    }

    case "watching": {
      const { values } = parse(argv.slice(1));
      const actor = values.actor || die("watching needs --actor <id>");
      const sub = await store.getWatch(proj(values), actor);
      console.log(sub && Object.keys(sub).length ? `${actor} watches ${fmtSub(sub)}` : `${actor} watches nothing`);
      break;
    }

    case "inbox": {
      // Drain this actor's inbox (advances its cursor unless --peek).
      const { values } = parse(argv.slice(1));
      const actor = values.actor || die("inbox needs --actor <id>");
      const { events } = await store.readInbox(proj(values), actor, { peek: !!values.peek });
      if (!events.length) {
        console.log("(inbox empty)");
        break;
      }
      for (const e of events) console.log(fmtEvent(e));
      break;
    }

    case "wait": {
      // Block until this actor has new inbox events (or timeout), then print + exit.
      const { values } = parse(argv.slice(1));
      const actor = values.actor || die("wait needs --actor <id>");
      const { events } = await store.waitInbox(proj(values), actor, {
        timeoutMs: values.timeout != null ? Number(values.timeout) : undefined,
        peek: !!values.peek,
      });
      if (!events.length) {
        console.log("(no new events)");
        break;
      }
      for (const e of events) console.log(fmtEvent(e));
      break;
    }

    case "sprint": {
      const sub = argv[1];
      const { values, positionals } = parse(argv.slice(2));
      if (sub === "new") {
        const s = await store.createSprint(proj(values), {
          id: values.id,
          name: values.name,
          startDate: values.start,
          endDate: values.end,
          goal: values.goal,
        });
        console.log(`created sprint ${s.id}`);
      } else if (sub === "close") {
        const id = positionals[0];
        if (!id) die("usage: sprint close -p <proj> <id>");
        await store.updateSprint(proj(values), id, { status: "closed" });
        console.log(`closed sprint ${id}`);
      } else if (sub === "edit") {
        const id = positionals[0];
        if (!id) die("usage: sprint edit -p <proj> <id> [--name ...] [--start ...] [--end ...] [--goal ...]");
        const patch = {};
        if (values.name != null) patch.name = values.name;
        if (values.start != null) patch.startDate = values.start;
        if (values.end != null) patch.endDate = values.end;
        if (values.goal != null) patch.goal = values.goal;
        await store.updateSprint(proj(values), id, patch);
        console.log(`updated sprint ${id}`);
      } else if (sub === "rm") {
        const id = positionals[0];
        if (!id) die("usage: sprint rm -p <proj> <id>");
        const r = await store.deleteSprint(proj(values), id);
        console.log(`deleted sprint ${id}${r.unassigned ? ` (unassigned ${r.unassigned} ticket(s))` : ""}`);
      } else if (sub === "ls") {
        for (const s of await store.listSprints(proj(values))) {
          console.log(`${s.id}  ${s.name}  [${s.status}]  ${s.startDate || "?"} → ${s.endDate || "?"}`);
        }
      } else {
        die("usage: sprint new|edit|close|rm|ls ...");
      }
      break;
    }

    default:
      console.log(
        [
          "clambake CLI",
          "commands: new, move, update, ac, note, attach, archive, archived, unarchive, ls, show, behind, rm, projects, newproject, sprint",
          "see top of cli.js for full usage",
        ].join("\n")
      );
  }
} catch (err) {
  die(err.message);
}
