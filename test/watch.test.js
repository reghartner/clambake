// Integration tests for the event-tailing watcher (watch.js): the liveness marker,
// firing on ANY change (notes, not just status), the poll backstop, and actor
// filtering. watch.js arms fs.watch + calls process.exit on import, so spawn it as a
// subprocess (async spawn, never spawnSync) against a shared temp CLAMBAKE_DATA.
// Events are driven through the in-process store, which writes the same events.ndjson
// the spawned watcher tails — so the store's DATA_DIR must match, hence one shared dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(__dirname, "..", "watch.js");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-watch-"));
process.env.CLAMBAKE_DATA = DATA;
const store = await import("../lib/store.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
function freshProject() {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
}
const liveFile = (slug) => path.join(DATA, slug, ".watch_live.json");
const eventsFile = (slug) => path.join(DATA, slug, "events.ndjson");

function spawnWatch(slug, args = []) {
  const child = spawn(process.execPath, [WATCH, slug, ...args], {
    env: { ...process.env, CLAMBAKE_DATA: DATA },
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
  const slug = freshProject();
  const w = spawnWatch(slug, ["--heartbeat-ms", "600000", "--poll-ms", "0"]);
  try {
    const live = await waitFor(() =>
      fs.existsSync(liveFile(slug)) ? JSON.parse(fs.readFileSync(liveFile(slug), "utf8")) : null
    );
    assert.ok(live, "liveness file should appear");
    assert.equal(live.pid, w.child.pid);
    assert.equal(live.project, slug);
    assert.ok(Number.isFinite(Date.parse(live.armedAt)));
    assert.ok(Number.isFinite(Date.parse(live.lastCheckAt)));
  } finally {
    w.child.kill();
    await w.exit;
  }
});

test("fires on a NOTE — any change wakes it, not just status moves", async () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" }); // emitted before arm → skipped (offset at EOF)
  const w = spawnWatch(slug, ["--heartbeat-ms", "600000", "--poll-ms", "100"]);
  try {
    await waitFor(() => fs.existsSync(liveFile(slug)));
    store.appendNote(slug, t.id, "ping from a teammate", undefined, "coder-2");
    const code = await w.exit;
    assert.equal(code, 0);
    assert.match(w.out(), /BOARD CHANGE/);
    assert.match(w.out(), new RegExp(`${t.id}: note`));
    assert.match(w.out(), /by coder-2/);
  } finally {
    w.child.kill();
  }
});

test("poll backstop catches a raw append fs.watch can miss, then exits 0", async () => {
  const slug = freshProject();
  const w = spawnWatch(slug, ["--heartbeat-ms", "600000", "--poll-ms", "100"]);
  try {
    await waitFor(() => fs.existsSync(liveFile(slug)));
    // Append straight to the log (an event fs.watch may not surface) — the poll re-read finds it.
    fs.appendFileSync(
      eventsFile(slug),
      JSON.stringify({ ts: new Date().toISOString(), type: "moved", ticket: "T-9", actor: "ui", from: "active", to: "done" }) + "\n"
    );
    const code = await w.exit;
    assert.equal(code, 0);
    assert.match(w.out(), /T-9: active -> done/);
  } finally {
    w.child.kill();
  }
});

test("--ignore-actor absorbs the watcher's own events (no fire)", async () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  const w = spawnWatch(slug, ["--ignore-actor", "pm-x", "--heartbeat-ms", "600000", "--poll-ms", "100"]);
  try {
    await waitFor(() => fs.existsSync(liveFile(slug)));
    store.appendNote(slug, t.id, "my own move", undefined, "pm-x");
    await sleep(500); // a few poll cycles
    assert.equal(w.child.exitCode, null, "should still be watching");
    assert.doesNotMatch(w.out(), /BOARD CHANGE/);
  } finally {
    w.child.kill();
    await w.exit;
  }
});
