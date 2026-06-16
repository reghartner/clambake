#!/usr/bin/env node
// Status-aware, actor-filtered, gap-safe board watcher.
//
// Blocks on fs.watch of a project's ticket files and exits when a ticket's STATUS
// changes (a column move) or a ticket is added/removed — so a host harness/agent
// can re-run on meaningful board changes (not every keystroke-level write). On exit
// it prints the changes; a heartbeat timeout exits cleanly if nothing happens.
//
//   node watch.js <project> [--ignore-actor <id>] [--heartbeat-ms <n>]
//
// --ignore-actor <id>  Skip changes whose frontmatter lastActor == <id> (e.g. the
//                      agent running this watcher, so it isn't woken by its own moves).
// --heartbeat-ms <n>   Exit after n ms with no change (default 1,800,000 = 30 min).
//
// GAP-SAFE: persists its last-seen snapshot to <project>/.watch_state.json and uses it
// as the baseline on start, then runs one immediate check — so a change that lands
// during the re-arm gap (after a fire, before the next arm) is caught on the next arm
// instead of being silently absorbed into a fresh baseline.
//
// Data dir resolution matches the server/CLI: CLAMBAKE_DATA, else <repo>/data/projects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "ignore-actor": { type: "string" },
    "heartbeat-ms": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const project = positionals[0];
const ignoreActor = values["ignore-actor"] || null;
const heartbeatMs = Number(values["heartbeat-ms"]) || 1_800_000; // 30 min default

if (!project) {
  console.error("usage: node watch.js <project> [--ignore-actor <id>] [--heartbeat-ms <n>]");
  process.exit(1);
}

const base = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "data", "projects");
const dir = path.join(base, project, "tickets");
const STATE = path.join(base, project, ".watch_state.json");

if (!fs.existsSync(dir)) {
  console.error(`no such project tickets dir: ${dir}`);
  process.exit(1);
}

// Snapshot each ticket's status + lastActor from frontmatter.
function snapshot() {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    const s = txt.match(/^status:\s*(.+)$/m);
    const a = txt.match(/^lastActor:\s*(.+)$/m);
    out[f] = { status: s ? s[1].trim() : "?", actor: a ? a[1].trim() : "ui" };
  }
  return out;
}
const persist = (snap) => {
  try {
    fs.writeFileSync(STATE, JSON.stringify(snap));
  } catch {}
};
const loadPrior = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
};

// Baseline = last-seen persisted snapshot (catches gap-moves), or fresh on first run.
let baseSnap = loadPrior() || snapshot();
persist(baseSnap);

let fired = false;
function check() {
  if (fired) return;
  const now = snapshot();
  const ids = new Set([...Object.keys(baseSnap), ...Object.keys(now)]);
  const changes = [];
  for (const id of ids) {
    const b = baseSnap[id];
    const n = now[id];
    const bStatus = b ? b.status : "(new)";
    const nStatus = n ? n.status : "(removed)";
    if (bStatus === nStatus) continue;
    const actor = n ? n.actor : b ? b.actor : "ui";
    if (ignoreActor && actor === ignoreActor) {
      baseSnap[id] = n || { status: "(removed)", actor }; // absorb my own change
      continue;
    }
    changes.push(`${id}: ${bStatus} -> ${nStatus} (by ${actor})`);
  }
  persist(now);
  if (changes.length) {
    fired = true;
    console.log("BOARD STATUS CHANGE:\n" + changes.join("\n"));
    process.exit(0);
  }
}

fs.watch(dir, { persistent: true }, () => setTimeout(check, 400)); // debounce the burst
setTimeout(() => {
  if (!fired) {
    console.log(`board watch heartbeat (no status change in ${Math.round(heartbeatMs / 60000)}m)`);
    process.exit(0);
  }
}, heartbeatMs);
console.log(`board watch armed on ${dir}${ignoreActor ? ` (ignoring actor=${ignoreActor})` : ""}`);
check(); // immediate catch-up for any change during the re-arm gap
