// Tests for CLI short-flag aliases (-t/--title etc.) and the test-steps loader
// (@file / stdin). Runs the CLI in local mode against a temp CLAMBAKE_DATA dir, so
// no server is needed; spawn async (never spawnSync) per the cli.test.js note.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "cli.js");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-flags-"));
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// Run the CLI; optional stdin string. Resolves { code, out }.
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

test("short flags set the same fields as their long names", async () => {
  await run(["newproject", "demo"]);
  const r = await run(["new", "-p", "demo", "-t", "Short flags", "-s", "planned", "-e", "Auth", "-a", "coder-9"]);
  assert.match(r.out, /created DEMO-1/);
  const t = await show("DEMO-1");
  assert.equal(t.title, "Short flags");
  assert.equal(t.status, "planned");
  assert.equal(t.epic, "Auth");
  assert.equal(t.lastActor, "coder-9");
});

test("-T @file loads multi-line test steps from a file", async () => {
  const f = path.join(DATA, "steps.md");
  fs.writeFileSync(f, "1. open\n2. click\n3. assert\n");
  await run(["new", "-p", "demo", "-t", "From file", "-T", `@${f}`]);
  const t = await show("DEMO-2");
  assert.equal(t.testSteps, "1. open\n2. click\n3. assert\n");
});

test("-T - loads test steps from stdin", async () => {
  await run(["new", "-p", "demo", "-t", "From stdin", "-T", "-"], "alpha\nbeta\n");
  const t = await show("DEMO-3");
  assert.equal(t.testSteps, "alpha\nbeta\n");
});

test("@@ escapes a literal leading @ instead of loading a file", async () => {
  await run(["new", "-p", "demo", "-t", "Literal at", "-T", "@@not-a-file"]);
  const t = await show("DEMO-4");
  assert.equal(t.testSteps, "@not-a-file");
});

test("update -T @file replaces test steps", async () => {
  const f = path.join(DATA, "steps2.md");
  fs.writeFileSync(f, "updated steps\n");
  await run(["update", "-p", "demo", "DEMO-1", "-T", `@${f}`]);
  assert.equal((await show("DEMO-1")).testSteps, "updated steps\n");
});

test("a misspelled long flag fails with a did-you-mean", async () => {
  const r = await run(["new", "-p", "demo", "--titel", "Oops"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown flag --titel\. Did you mean --title\?/);
  // and nothing was created from the bad command
  assert.doesNotMatch(r.out, /created/);
});

test("an unknown short flag fails without a bogus suggestion", async () => {
  const r = await run(["new", "-p", "demo", "-z", "x"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown flag -z\./);
  assert.doesNotMatch(r.out, /Did you mean/);
});

test("a flag missing its value reports the flag cleanly", async () => {
  const r = await run(["new", "-p", "demo", "-t"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /flag -t needs a value/);
});

test("invalid --priority lists the valid set", async () => {
  const r = await run(["new", "-p", "demo", "-t", "Z", "--priority", "huge"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /invalid --priority "huge"\. valid: low, med, high/);
});

test("invalid status lists the project's columns", async () => {
  const r = await run(["move", "-p", "demo", "DEMO-1", "dones"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /invalid status "dones".*valid columns: .*done/s);
});
