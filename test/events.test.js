// Tests that store mutations emit the right events to events.ndjson, and that the
// readEvents cursor advances correctly. Point CLAMBAKE_DATA at a temp dir before
// importing the store (same pattern as store.test.js / archive.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-events-"));
process.env.CLAMBAKE_DATA = DATA;

const store = await import("../lib/store.js");
const { readEvents, eventOffset } = await import("../lib/events.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
const freshProject = () => {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
};

test("each mutation emits a typed event", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "Hello", epic: "Auth" });
  store.updateTicket(slug, t.id, { status: "active" }); // moved
  store.updateTicket(slug, t.id, { assignee: "coder-1", priority: "high" }); // edited
  store.appendNote(slug, t.id, "a note", undefined, "coder-1"); // noted

  const { events } = readEvents(slug, 0);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["created", "moved", "edited", "noted"]);

  const created = events[0];
  assert.equal(created.ticket, t.id);
  assert.equal(created.title, "Hello");
  assert.equal(created.epic, "Auth");
  assert.ok(Number.isFinite(Date.parse(created.ts)));

  const moved = events[1];
  assert.equal(moved.from, "backlog");
  assert.equal(moved.to, "active");

  assert.deepEqual(events[2].fields.sort(), ["assignee", "priority"]);
  assert.equal(events[3].actor, "coder-1");
});

test("a single update emits both moved and edited when both change", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  const before = eventOffset(slug);
  store.updateTicket(slug, t.id, { status: "active", assignee: "z" });
  const { events } = readEvents(slug, before);
  assert.deepEqual(events.map((e) => e.type), ["moved", "edited"]);
});

test("readEvents advances the cursor and returns only new events", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  const first = readEvents(slug, 0);
  assert.equal(first.events.length, 1);
  // Nothing new yet.
  assert.deepEqual(readEvents(slug, first.offset).events, []);
  // A new mutation shows up only past the cursor.
  store.updateTicket(slug, t.id, { status: "done" });
  const next = readEvents(slug, first.offset);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, "moved");
  assert.ok(next.offset > first.offset);
});

test("a partial trailing line is not consumed until complete", () => {
  const slug = freshProject();
  const file = path.join(DATA, slug, "events.ndjson");
  store.createTicket(slug, { title: "x" }); // ensures file exists with one full line
  const after = readEvents(slug, 0);
  // Append a half-written line (no newline yet).
  fs.appendFileSync(file, '{"type":"moved","ticket":"T-1"');
  const mid = readEvents(slug, after.offset);
  assert.deepEqual(mid.events, []);
  assert.equal(mid.offset, after.offset, "cursor must not advance past a partial line");
  // Finish the line; now it parses.
  fs.appendFileSync(file, ',"actor":"ui","from":"a","to":"b"}\n');
  const done = readEvents(slug, after.offset);
  assert.equal(done.events.length, 1);
  assert.equal(done.events[0].to, "b");
});

test("archive / unarchive emit system events", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", status: "done" });
  const before = eventOffset(slug);
  store.archiveTicket(slug, t.id);
  store.unarchiveTicket(slug, t.id);
  const { events } = readEvents(slug, before);
  assert.deepEqual(events.map((e) => e.type), ["archived", "unarchived"]);
  assert.equal(events[0].actor, "system");
});
