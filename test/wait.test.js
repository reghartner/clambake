// Tests for the long-poll waitInbox: returns pending events immediately, blocks until a
// matching event arrives, and times out cleanly. Temp CLAMBAKE_DATA before import.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-wait-"));
process.env.CLAMBAKE_DATA = DATA;

const store = await import("../lib/store.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
const freshProject = () => {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("returns pending events immediately", async () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.setWatch(slug, "w", { tickets: [t.id] });
  store.appendNote(slug, t.id, "already here", undefined, "other");
  const r = await store.waitInbox(slug, "w", { timeoutMs: 5000 });
  assert.equal(r.events.length, 1);
  assert.ok(!r.timedOut);
});

test("blocks, then resolves when a matching event arrives", async () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.setWatch(slug, "w", { tickets: [t.id] });
  const p = store.waitInbox(slug, "w", { timeoutMs: 5000 });
  await sleep(150); // ensure it's actually blocking
  store.appendNote(slug, t.id, "@nobody just a change", undefined, "other");
  const r = await p;
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, "noted");
});

test("times out cleanly with no events", async () => {
  const slug = freshProject();
  store.setWatch(slug, "w", { tickets: ["T-404"] });
  const r = await store.waitInbox(slug, "w", { timeoutMs: 200 });
  assert.deepEqual(r.events, []);
  assert.equal(r.timedOut, true);
});

test("back-to-back waits are gap-free (cursor persists)", async () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.setWatch(slug, "w", { tickets: [t.id] });
  store.appendNote(slug, t.id, "one", undefined, "other");
  const first = await store.waitInbox(slug, "w", { timeoutMs: 1000 });
  assert.equal(first.events.length, 1);
  // A second event after the first drain is caught by the next wait, none lost/repeated.
  store.appendNote(slug, t.id, "two", undefined, "other");
  const second = await store.waitInbox(slug, "w", { timeoutMs: 2000 });
  assert.equal(second.events.length, 1);
  assert.match(second.events[0].summary, /two/);
});
