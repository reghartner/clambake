#!/usr/bin/env node
// Actor-filtered, gap-safe board watcher — fires on ANY change.
//
// Tails the project's append-only event log (data/projects/<project>/events.ndjson,
// written by the store on every mutation) and exits the moment a relevant event
// lands — a move, a note, an edit, an archive, anything — so a host harness/agent
// can re-run on meaningful board changes. (Earlier versions diffed ticket *status*
// off the files and so missed notes/edits; tailing the event log catches them all.)
//
//   node watch.js <project> [--ignore-actor <id>] [--heartbeat-ms <n>] [--poll-ms <n>]
//
// --ignore-actor <id>  Skip events whose actor == <id> (e.g. the agent running this
//                      watcher, so it isn't woken by its own writes).
// --heartbeat-ms <n>   Exit after n ms with no event (default 1,800,000 = 30 min).
// --poll-ms <n>        Backstop poll interval (default 5,000). fs.watch can miss
//                      appends on macOS, so re-read every n ms too; 0 disables it.
//
// GAP-SAFE: persists its byte OFFSET into the log to <project>/.watch_state.json and
// resumes from it on start, then checks immediately — so an event that lands during
// the re-arm gap (after a fire, before the next arm) is caught on the next arm. A
// fresh watcher (no saved offset) starts at end-of-log, ignoring history.
//
// LIVENESS: writes <project>/.watch_live.json on arm and every minute thereafter
// (pid + armedAt + lastCheckAt, all UTC). A dead watcher and a quiet board look
// identical from the outside — this file lets a supervisor or agent tell them apart:
// if lastCheckAt is stale, the watcher died and should be re-armed. See watch-loop.sh
// for an auto-re-arming supervisor that keeps this watcher alive across fires.
//
// Data dir resolution matches the server/CLI: CLAMBAKE_DATA, else <repo>/data/projects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readEvents, eventOffset } from "./lib/events.js";

// The harness/background wrapper can deliver SIGURG at turn boundaries (observed as a
// spurious exit 144); it carries no urgent-data semantics for this workload, so absorb
// it instead of dying. SIGTERM/SIGINT keep their defaults so a real stop still works.
process.on("SIGURG", () => {});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "ignore-actor": { type: "string" },
    "heartbeat-ms": { type: "string" },
    "poll-ms": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const project = positionals[0];
const ignoreActor = values["ignore-actor"] || null;
const heartbeatMs = Number(values["heartbeat-ms"]) || 1_800_000; // 30 min default
const pollMs = values["poll-ms"] != null ? Number(values["poll-ms"]) : 5_000; // 0 = off

if (!project) {
  console.error("usage: node watch.js <project> [--ignore-actor <id>] [--heartbeat-ms <n>] [--poll-ms <n>]");
  process.exit(1);
}

const base = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "data", "projects");
const projectDir = path.join(base, project);
const STATE = path.join(projectDir, ".watch_state.json");
const LIVE = path.join(projectDir, ".watch_live.json");

if (!fs.existsSync(projectDir)) {
  console.error(`no such project: ${projectDir}`);
  process.exit(1);
}

const persist = (offset) => {
  try {
    fs.writeFileSync(STATE, JSON.stringify({ offset }));
  } catch {}
};
const loadOffset = () => {
  try {
    const v = JSON.parse(fs.readFileSync(STATE, "utf8")).offset;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

// Liveness marker: lets a supervisor/agent distinguish "watcher died" from "board quiet".
const armedAt = new Date().toISOString();
const writeLive = () => {
  try {
    fs.writeFileSync(
      LIVE,
      JSON.stringify({ pid: process.pid, project, ignoreActor, armedAt, lastCheckAt: new Date().toISOString() })
    );
  } catch {}
};

// One-line human summary of an event.
function fmt(ev) {
  const who = ev.actor ? ` (by ${ev.actor})` : "";
  switch (ev.type) {
    case "moved":
      return `${ev.ticket}: ${ev.from} -> ${ev.to}${who}`;
    case "created":
      return `${ev.ticket}: created [${ev.status}] ${ev.title || ""}`.trimEnd() + who;
    case "noted":
      return `${ev.ticket}: note${ev.summary ? ` — ${ev.summary}` : ""}${who}`;
    case "edited":
      return `${ev.ticket}: edited ${(ev.fields || []).join(", ")}${who}`;
    case "attached":
      return `${ev.ticket}: attached ${ev.summary || ""}`.trimEnd() + who;
    default:
      return `${ev.ticket}: ${ev.type}${who}`;
  }
}

// Resume from saved offset (gap-safe), or start at end-of-log on a fresh watcher.
let offset = loadOffset();
if (offset == null) offset = eventOffset(project);
persist(offset);

let fired = false;
function check() {
  if (fired) return;
  writeLive(); // stamp lastCheckAt so a stale marker reliably means "stopped checking"
  const { events, offset: next } = readEvents(project, offset);
  offset = next;
  persist(offset);
  const relevant = events.filter((e) => !(ignoreActor && e.actor === ignoreActor));
  if (relevant.length) {
    fired = true;
    console.log("BOARD CHANGE:\n" + relevant.map(fmt).join("\n"));
    process.exit(0);
  }
}

fs.watch(projectDir, { persistent: true }, () => setTimeout(check, 400)); // debounce the burst
// Backstop poll: fs.watch can miss appends to the log, so re-read on a low-frequency
// timer too. unref so it never holds the process open alone.
if (pollMs > 0) setInterval(check, pollMs).unref();
// Keep the liveness marker fresh even on a totally quiet board (check() may not run for a while).
setInterval(writeLive, 60_000).unref();
setTimeout(() => {
  if (!fired) {
    console.log(`board watch heartbeat (no change in ${Math.round(heartbeatMs / 60000)}m)`);
    process.exit(0);
  }
}, heartbeatMs);
console.log(`board watch armed on ${projectDir}${ignoreActor ? ` (ignoring actor=${ignoreActor})` : ""}`);
check(); // immediate catch-up for any event during the re-arm gap
