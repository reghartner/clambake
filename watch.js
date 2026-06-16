#!/usr/bin/env node
// Generic board watcher. Blocks on fs.watch of a project's ticket files and exits
// on the first change (or a heartbeat timeout) — so a host harness/agent can re-run
// whatever it does on board changes. Event-driven (OS-native), not a CPU poll.
//
//   node watch.js <project> [heartbeatMs]
//
// Data dir resolution matches the server/CLI: CLAMBAKE_DATA, else <repo>/data/projects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const project = process.argv[2];
const heartbeatMs = Number(process.argv[3]) || 1_800_000; // 30 min default

if (!project) {
  console.error("usage: node watch.js <project> [heartbeatMs]");
  process.exit(1);
}

const base = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "data", "projects");
const dir = path.join(base, project, "tickets");

if (!fs.existsSync(dir)) {
  console.error(`no such project tickets dir: ${dir}`);
  process.exit(1);
}

let fired = false;
function done(msg) {
  if (fired) return;
  fired = true;
  console.log(msg);
  process.exit(0);
}

const w = fs.watch(dir, { persistent: true }, (ev, f) => {
  if (fired) return;
  // small debounce: let the burst settle, then exit
  setTimeout(() => {
    try {
      w.close();
    } catch {}
    done(`BOARD CHANGE: ${ev} ${f}`);
  }, 400);
});

setTimeout(() => done(`BOARD WATCH heartbeat (no change in ${Math.round(heartbeatMs / 60000)}m)`), heartbeatMs);
console.log(`board watch armed on ${dir}`);
