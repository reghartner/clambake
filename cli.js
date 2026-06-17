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
//   node cli.js projects
//   node cli.js newproject <slug> [--name "..."] [--prefix MET] [--stale 5]
//   node cli.js sprint new -p <proj> --id s1 --name "Sprint 1" [--start ...] [--end ...] [--goal ...]
//   node cli.js sprint close -p <proj> <id>

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { makeClient } from "./lib/api-client.js";

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
  const options = {
    p: { type: "string", short: "p" },
    project: { type: "string" },
    title: { type: "string" },
    status: { type: "string" },
    sprint: { type: "string" },
    epic: { type: "string" },
    priority: { type: "string" },
    assignee: { type: "string" },
    due: { type: "string" },
    "test-steps": { type: "string" },
    actor: { type: "string" },
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    stale: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    goal: { type: "string" },
    behind: { type: "boolean" },
    ac: { type: "string", multiple: true },
    label: { type: "string", multiple: true },
    link: { type: "string", multiple: true },
  };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: false });
  return { values, positionals };
}

function proj(values) {
  const p = values.p || values.project;
  if (!p) die("Missing -p <project>");
  return p;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
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
      const t = await store.createTicket(
        proj(values),
        {
          title: values.title,
          status: values.status,
          sprint: values.sprint,
          epic: values.epic,
          priority: values.priority,
          assignee: values.assignee,
          dueDate: values.due,
          testSteps: values["test-steps"],
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
      const t = await store.updateTicket(proj(values), id, { status }, values.actor || "ui");
      console.log(`${t.id} -> ${t.status}`);
      break;
    }

    case "update": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      if (!id) die("usage: update -p <proj> <id> [flags]");
      const patch = {};
      if (values.title != null) patch.title = values.title;
      if (values.status != null) patch.status = values.status;
      if (values.sprint != null) patch.sprint = values.sprint === "none" ? null : values.sprint;
      if (values.epic != null) patch.epic = values.epic === "none" ? "" : values.epic;
      if (values.priority != null) patch.priority = values.priority;
      if (values.assignee != null) patch.assignee = values.assignee;
      if (values.due != null) patch.dueDate = values.due === "none" ? null : values.due;
      if (values["test-steps"] != null) patch.testSteps = values["test-steps"] === "none" ? "" : values["test-steps"];
      if (values.label) patch.labels = values.label;
      if (values.link) patch.links = values.link;
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
      await store.updateTicket(proj(values), id, { ac }, values.actor || "ui");
      console.log(`${id} ac updated (${ac.filter((a) => a.done).length}/${ac.length})`);
      break;
    }

    case "note": {
      const { values, positionals } = parse(argv.slice(1));
      const id = positionals[0];
      const text = positionals.slice(1).join(" ");
      if (!id || !text) die('usage: note -p <proj> <id> "text"');
      await store.appendNote(proj(values), id, text, undefined, values.actor || "ui");
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
          "commands: new, move, update, ac, note, attach, ls, show, behind, rm, projects, newproject, sprint",
          "see top of cli.js for full usage",
        ].join("\n")
      );
  }
} catch (err) {
  die(err.message);
}
