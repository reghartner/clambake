// MET-469 Fix 1: `--epic` is repeatable. For `watch` it unions into a list (both kept);
// for `new`/`update` a ticket has one epic, so the LAST value wins. Local mode against a
// temp CLAMBAKE_DATA, spawn async (never spawnSync — it deadlocks) per the cli.test.js note.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "cli.js");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-watch-epic-"));
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// Run the CLI in local mode; resolves { code, out }.
function run(args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, CLAMBAKE_DATA: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  return new Promise((res) => child.on("close", (code) => res({ code, out })));
}
const show = async (id) => JSON.parse((await run(["show", "-p", "demo", id])).out);

test("watch --epic A --epic B registers BOTH epics", async () => {
  await run(["newproject", "demo"]);
  const r = await run(["watch", "-p", "demo", "--actor", "me", "--epic", "A", "--epic", "B"]);
  assert.equal(r.code, 0, r.out);

  // Via `watching` output (fmtSub renders epics=[A,B]).
  const w = await run(["watching", "-p", "demo", "--actor", "me"]);
  assert.match(w.out, /epics=\[A,B\]/);

  // And via the persisted subscription itself.
  const sub = JSON.parse(fs.readFileSync(path.join(DATA, "demo", "watchers.json"), "utf8"));
  assert.deepEqual(sub.me.epics, ["A", "B"]);
});

test("new --epic X --epic Y keeps a single epic (the last, Y)", async () => {
  const r = await run(["new", "-p", "demo", "-t", "Repeatable epic", "--epic", "X", "--epic", "Y"]);
  assert.match(r.out, /created DEMO-1/);
  assert.equal((await show("DEMO-1")).epic, "Y");
});

test("update --epic X --epic Y keeps the last epic (Y)", async () => {
  await run(["update", "-p", "demo", "DEMO-1", "--epic", "X", "--epic", "Y"]);
  assert.equal((await show("DEMO-1")).epic, "Y");
});
