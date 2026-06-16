// Tests for the file-backed store: path-traversal guard, id allocation,
// optimistic-concurrency, and the pure "behind" computation.
//
// The store resolves its data dir from CLAMBAKE_DATA at import time, so we set
// that to a throwaway temp dir BEFORE importing it (dynamic import below).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-test-"));
process.env.CLAMBAKE_DATA = DATA_DIR;

const store = await import("../lib/store.js");
const { computeBehind, nextId } = await import("../lib/schema.js");

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

// A fresh project per test keeps them independent.
let n = 0;
function freshProject() {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
}

test("safeSeg rejects path-traversal segments", () => {
  // Each public entry point that takes a slug/id/filename must reject "." / "..".
  assert.throws(() => store.getProject(".."), /Invalid project/);
  assert.throws(() => store.getProject("."), /Invalid project/);

  const slug = freshProject();
  assert.throws(() => store.getTicket(slug, ".."), /Invalid ticket id/);
  assert.throws(() => store.attachmentFile(slug, "..", "x.png"), /Invalid/);
  assert.throws(() => store.attachmentFile(slug, "T-1", ".."), /Invalid attachment/);
  // A legit segment with dots in it is still allowed.
  assert.throws(() => store.getTicket(slug, "T-1.foo"), /No such ticket/); // 404, not 400
});

test("createTicket allocates unique sequential ids", () => {
  const slug = freshProject();
  const a = store.createTicket(slug, { title: "one" });
  const b = store.createTicket(slug, { title: "two" });
  assert.equal(a.id, "T-1");
  assert.equal(b.id, "T-2");
});

// store.createTicket is synchronous, so these run sequentially in one process —
// this verifies id allocation over many creates, not a true cross-process race
// (that's the O_EXCL "wx" path, which a single Node process can't reproduce).
test("createTicket never reuses an id across many creates", async () => {
  const slug = freshProject();
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, i) => Promise.resolve().then(() => store.createTicket(slug, { title: `t${i}` })))
  );
  const ids = created.map((t) => t.id);
  assert.equal(new Set(ids).size, 25, "all ids unique");
  assert.equal(store.listTickets(slug).length, 25);
});

test("explicit duplicate id is rejected", () => {
  const slug = freshProject();
  store.createTicket(slug, { id: "T-99", title: "first" });
  assert.throws(() => store.createTicket(slug, { id: "T-99", title: "dup" }), /already exists/);
});

test("updateTicket optimistic-concurrency guard", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  // Stale token -> 409.
  assert.throws(
    () => store.updateTicket(slug, t.id, { title: "y", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" }),
    /Conflict/
  );
  // Correct token -> succeeds.
  const ok = store.updateTicket(slug, t.id, { title: "y", expectedUpdatedAt: t.updatedAt });
  assert.equal(ok.title, "y");
  // No token -> CLI path always wins.
  const win = store.updateTicket(slug, t.id, { title: "z" });
  assert.equal(win.title, "z");
});

test("invalid status / priority are rejected", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  assert.throws(() => store.updateTicket(slug, t.id, { status: "nonsense" }), /Invalid status/);
  assert.throws(() => store.updateTicket(slug, t.id, { priority: "urgent" }), /Invalid priority/);
});

test("deleteSprint unassigns its tickets", () => {
  const slug = freshProject();
  store.createSprint(slug, { id: "s1", name: "Sprint 1" });
  const t = store.createTicket(slug, { title: "x", sprint: "s1" });
  const r = store.deleteSprint(slug, "s1");
  assert.equal(r.unassigned, 1);
  assert.equal(store.getTicket(slug, t.id).sprint, null);
});

// ---- pure schema logic (no fs) ----
test("nextId picks max+1 for the prefix only", () => {
  assert.equal(nextId(["T-1", "T-7", "OTHER-9", "T-3"], "T"), "T-8");
  assert.equal(nextId([], "T"), "T-1");
});

test("computeBehind flags stale, past-due, and ended sprints", () => {
  const now = new Date("2026-06-16T00:00:00Z");
  const done = { status: "done", updatedAt: "2000-01-01T00:00:00Z" };
  assert.equal(computeBehind(done, null, 5, now).behind, false, "done is never behind");

  const fresh = { status: "active", updatedAt: "2026-06-15T00:00:00Z" };
  assert.equal(computeBehind(fresh, null, 5, now).behind, false);

  const stale = { status: "active", updatedAt: "2026-06-01T00:00:00Z" };
  assert.equal(computeBehind(stale, null, 5, now).behind, true);
  assert.match(computeBehind(stale, null, 5, now).reason, /stale/);

  const due = { status: "active", updatedAt: "2026-06-15T00:00:00Z", dueDate: "2026-06-10" };
  assert.match(computeBehind(due, null, 5, now).reason, /past due/);

  const endedSprint = { endDate: "2026-06-10" };
  assert.match(computeBehind(fresh, endedSprint, 5, now).reason, /sprint ended/);
});
