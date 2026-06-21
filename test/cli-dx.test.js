// MET-478 + MET-479: CLI/watch DX papercuts. Local mode against a temp CLAMBAKE_DATA
// (no server needed); spawn async (never spawnSync — it deadlocks) per the cli.test.js
// note. Covers: note `--` passthrough + --stdin; attach --link populates links[] and
// does NOT ENOENT on a URL; ls --status/--active filtering; watch --replace sets the
// exact set; unwatch preserves notify. The on-disk subscription registry is
// CLAMBAKE_DATA/<slug>/watchers.json.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "cli.js");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-dx-"));
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// Run the CLI in local mode; optional stdin string. Resolves { code, out }.
function run(args, stdin = null) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, CLAMBAKE_DATA: DATA },
    stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  if (stdin != null) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  return new Promise((res) => child.on("close", (code) => res({ code, out })));
}
const show = async (id) => JSON.parse((await run(["show", "-p", "demo", id])).out);
const watchers = () => JSON.parse(fs.readFileSync(path.join(DATA, "demo", "watchers.json"), "utf8"));

test("setup project + a ticket", async () => {
  await run(["newproject", "demo"]);
  const r = await run(["new", "-p", "demo", "-t", "Note target"]);
  assert.match(r.out, /created DEMO-1/);
});

// --- MET-478.1: note text eats dash-prefixed tokens -------------------------
test("note -- records dash-prefixed tokens verbatim", async () => {
  const r = await run(["note", "-p", "demo", "DEMO-1", "--", "text with", "--weird", "--tokens", "and a", "-dash"]);
  assert.equal(r.code, 0, r.out);
  const body = (await show("DEMO-1")).body;
  assert.match(body, /text with --weird --tokens and a -dash/);
});

test("note --stdin reads the body from stdin", async () => {
  const r = await run(["note", "-p", "demo", "DEMO-1", "--stdin"], "piped note with --flagish text\nsecond line\n");
  assert.equal(r.code, 0, r.out);
  const body = (await show("DEMO-1")).body;
  assert.match(body, /piped note with --flagish text/);
  assert.match(body, /second line/);
});

test("note --stdin wins over positional text when both are given", async () => {
  const r = await run(["note", "-p", "demo", "DEMO-1", "--stdin", "--", "ignored positional"], "stdin-body-wins\n");
  assert.equal(r.code, 0, r.out);
  const body = (await show("DEMO-1")).body;
  assert.match(body, /stdin-body-wins/);
  assert.doesNotMatch(body, /ignored positional/);
});

// --- MET-478.2: attach rejects URLs -----------------------------------------
test("attach --link populates links[] (and does not ENOENT)", async () => {
  const r = await run(["attach", "-p", "demo", "DEMO-1", "--link", "https://example.com/pr/1"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ENOENT/);
  assert.doesNotMatch(r.out, /cannot read/);
  assert.deepEqual((await show("DEMO-1")).links, ["https://example.com/pr/1"]);
});

test("attach <https-url> auto-detects a URL and records it, no ENOENT", async () => {
  const r = await run(["attach", "-p", "demo", "DEMO-1", "https://example.com/pr/2"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ENOENT/);
  // appended to the existing link, de-duped
  assert.deepEqual((await show("DEMO-1")).links, ["https://example.com/pr/1", "https://example.com/pr/2"]);
});

test("attach still reads a real local file (file behavior unchanged)", async () => {
  const img = path.join(DATA, "shot.png");
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic, enough for a blob
  const r = await run(["attach", "-p", "demo", "DEMO-1", img]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /attached shot\.png to DEMO-1/);
  assert.ok((await show("DEMO-1")).attachments.includes("shot.png"));
});

// --- MET-478.3: ls has no status/column filter ------------------------------
test("ls --status (repeatable) and --active filter by column", async () => {
  await run(["new", "-p", "demo", "-t", "Done A", "-s", "done"]);
  await run(["new", "-p", "demo", "-t", "Done B", "-s", "done"]);
  await run(["new", "-p", "demo", "-t", "Active A", "-s", "active"]);
  await run(["new", "-p", "demo", "-t", "Blocked A", "-s", "blocked"]);

  // DEMO-1 is in the default column (backlog); plus 2 done, 1 active, 1 blocked.
  const lines = (out) => out.split("\n").filter((l) => /^DEMO-\d/.test(l));

  const all = lines((await run(["ls", "-p", "demo"])).out);
  assert.equal(all.length, 5);

  const done = lines((await run(["ls", "-p", "demo", "--status", "done"])).out);
  assert.equal(done.length, 2);

  // repeatable --status keeps several columns
  const multi = lines((await run(["ls", "-p", "demo", "--status", "active", "--status", "blocked"])).out);
  assert.equal(multi.length, 2);

  // --active = every non-done column (backlog + active + blocked = 3)
  const active = lines((await run(["ls", "-p", "demo", "--active"])).out);
  assert.equal(active.length, 3);
  assert.ok(active.every((l) => !l.includes("[done]")));

  // --status wins if both are given (explicit set overrides the shortcut)
  const both = lines((await run(["ls", "-p", "demo", "--active", "--status", "done"])).out);
  assert.equal(both.length, 2);
});

// --- MET-479.1: watch merges instead of replacing ---------------------------
test("watch is additive by default, but --replace sets the exact set", async () => {
  await run(["watch", "-p", "demo", "-a", "w1", "--epic", "A", "--notify", "http://localhost:9023/wake"]);
  // additive (default): re-running with B yields [A,B]
  await run(["watch", "-p", "demo", "-a", "w1", "--epic", "B"]);
  assert.deepEqual(watchers().w1.epics, ["A", "B"]);

  // --replace SETS the exact set in one call
  await run(["watch", "-p", "demo", "-a", "w1", "--replace", "--epic", "C", "--epic", "D"]);
  assert.deepEqual(watchers().w1.epics, ["C", "D"]);
  // notify is preserved across a replace that doesn't pass --notify
  assert.equal(watchers().w1.notify, "http://localhost:9023/wake");
});

// --- MET-479.2: unwatch silently clears notify ------------------------------
test("unwatch removes only the named filter and PRESERVES notify", async () => {
  // repro from the ticket
  await run(["watch", "-p", "demo", "-a", "w2", "--epic", "A", "--notify", "http://localhost:9023/wake"]);
  await run(["watch", "-p", "demo", "-a", "w2", "--epic", "B"]); // additive -> [A,B]
  assert.deepEqual(watchers().w2.epics, ["A", "B"]);

  await run(["unwatch", "-p", "demo", "-a", "w2", "--epic", "A"]);
  assert.deepEqual(watchers().w2.epics, ["B"]);
  // the notify URL MUST survive removing an unrelated epic
  assert.equal(watchers().w2.notify, "http://localhost:9023/wake");
});

test("watch --replace --epic B sets [B] (vs additive [A,B])", async () => {
  await run(["watch", "-p", "demo", "-a", "w3", "--epic", "A"]);
  await run(["watch", "-p", "demo", "-a", "w3", "--replace", "--epic", "B"]);
  assert.deepEqual(watchers().w3.epics, ["B"]);
});
