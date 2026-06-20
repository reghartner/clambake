// Integration tests for the board watcher robustness wiring (watch.js): the liveness
// marker and the poll backstop. watch.js arms fs.watch and calls process.exit on import,
// so it can't be imported — spawn it as a subprocess (async spawn, never spawnSync) against
// a temp CLAMBAKE_DATA project, like the CLI tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(__dirname, "..", "watch.js");

// Build a temp data dir with one project + ticket. Returns paths.
function freshProject(status = "active", actor = "ui") {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-watch-"));
  const proj = path.join(data, "demo");
  const tickets = path.join(proj, "tickets");
  fs.mkdirSync(tickets, { recursive: true });
  const ticket = path.join(tickets, "T-1.md");
  fs.writeFileSync(ticket, `---\nid: T-1\nstatus: ${status}\nlastActor: ${actor}\n---\nbody\n`);
  return { data, proj, ticket };
}

// Mirror the store's atomic write: temp file + rename. This is exactly the write fs.watch
// can miss on macOS, so it exercises the poll backstop rather than the fs.watch path.
function renameWrite(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// Spawn watch.js; collect stdout lines and resolve `exit` on close.
function spawnWatch(data, args = []) {
  const child = spawn(process.execPath, [WATCH, "demo", ...args], {
    env: { ...process.env, CLAMBAKE_DATA: data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const exit = new Promise((res) => child.on("close", (code) => res(code)));
  return { child, exit, out: () => out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 100, gap = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

test("writes a liveness marker on arm (pid + armedAt + lastCheckAt)", async () => {
  const { data, proj } = freshProject();
  const w = spawnWatch(data, ["--heartbeat-ms", "600000", "--poll-ms", "0"]);
  try {
    const live = path.join(proj, ".watch_live.json");
    const found = await waitFor(() => (fs.existsSync(live) ? JSON.parse(fs.readFileSync(live, "utf8")) : null));
    assert.ok(found, "liveness file should appear");
    assert.equal(found.pid, w.child.pid);
    assert.equal(found.project, "demo");
    assert.ok(Number.isFinite(Date.parse(found.armedAt)), "armedAt is an ISO timestamp");
    assert.ok(Number.isFinite(Date.parse(found.lastCheckAt)), "lastCheckAt is an ISO timestamp");
  } finally {
    w.child.kill();
    await w.exit;
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("poll backstop catches a rename-write fs.watch can miss, then fires + exits 0", async () => {
  const { data, proj, ticket } = freshProject("active");
  // Short poll so the backstop, not fs.watch, is what catches the rename.
  const w = spawnWatch(data, ["--heartbeat-ms", "600000", "--poll-ms", "100"]);
  try {
    // Wait until armed (liveness present) so the change lands after the baseline is set.
    await waitFor(() => fs.existsSync(path.join(proj, ".watch_live.json")));
    renameWrite(ticket, `---\nid: T-1\nstatus: done\nlastActor: ui\n---\nbody\n`);
    const code = await w.exit;
    assert.equal(code, 0);
    assert.match(w.out(), /BOARD STATUS CHANGE/);
    assert.match(w.out(), /T-1\.md: active -> done/);
  } finally {
    w.child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("--ignore-actor absorbs the watcher's own moves (no fire)", async () => {
  const { data, proj, ticket } = freshProject("active");
  const w = spawnWatch(data, ["--ignore-actor", "pm-x", "--heartbeat-ms", "600000", "--poll-ms", "100"]);
  try {
    await waitFor(() => fs.existsSync(path.join(proj, ".watch_live.json")));
    renameWrite(ticket, `---\nid: T-1\nstatus: done\nlastActor: pm-x\n---\nbody\n`);
    // Give the poll a few cycles; it must NOT fire on our own actor's change.
    await sleep(500);
    assert.equal(w.child.exitCode, null, "should still be watching");
    assert.doesNotMatch(w.out(), /BOARD STATUS CHANGE/);
  } finally {
    w.child.kill();
    await w.exit;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
