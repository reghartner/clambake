// Tests for the subscription registry + per-actor inbox fan-out. Point CLAMBAKE_DATA
// at a temp dir before importing the store (same pattern as the other store tests).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-inbox-"));
process.env.CLAMBAKE_DATA = DATA;

const store = await import("../lib/store.js");
const { subMatches } = await import("../lib/watchers.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
const freshProject = () => {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
};
const drain = (slug, actor, opts) => store.readInbox(slug, actor, opts).events;

test("setWatch unions interests; getWatch reflects them", () => {
  const slug = freshProject();
  store.setWatch(slug, "a", { epics: ["Auth"], columns: ["done"] });
  store.setWatch(slug, "a", { tickets: ["T-1"], epics: ["Auth"] }); // union, no dup epic
  const sub = store.getWatch(slug, "a");
  assert.deepEqual(sub.epics, ["Auth"]);
  assert.deepEqual(sub.tickets, ["T-1"]);
  assert.deepEqual(sub.columns, ["done"]);
});

test("subMatches matches by ticket, epic, destination column, and mention", () => {
  const sub = { tickets: ["T-1"], epics: ["Auth"], columns: ["done"], mentions: true };
  assert.ok(subMatches(sub, "a", { ticket: "T-1", type: "noted" }));
  assert.ok(subMatches(sub, "a", { ticket: "T-9", epic: "Auth", type: "edited" }));
  assert.ok(subMatches(sub, "a", { ticket: "T-9", type: "moved", to: "done" }));
  assert.ok(subMatches(sub, "a", { ticket: "T-9", type: "noted", mentions: ["a"] }));
  assert.ok(!subMatches(sub, "a", { ticket: "T-9", type: "moved", to: "active" }));
  assert.ok(!subMatches(sub, "b", { ticket: "T-9", type: "noted", mentions: ["a"] })); // mention is for a, not b
});

test("an event fans out to a matching subscriber's inbox", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", epic: "Auth" });
  store.setWatch(slug, "watcher", { epics: ["Auth"] });
  store.updateTicket(slug, t.id, { status: "active" }, "someone");
  const events = drain(slug, "watcher");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "moved");
  assert.equal(events[0].to, "active");
});

test("draining advances the cursor; --peek does not", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.setWatch(slug, "w", { tickets: [t.id] });
  store.appendNote(slug, t.id, "hi", undefined, "other");

  assert.equal(drain(slug, "w", { peek: true }).length, 1); // peek shows it
  assert.equal(drain(slug, "w", { peek: true }).length, 1); // still there
  assert.equal(drain(slug, "w").length, 1); // real read
  assert.equal(drain(slug, "w").length, 0); // now drained
});

test("an actor is never notified of its own action", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", epic: "Auth" });
  store.setWatch(slug, "self", { epics: ["Auth"] });
  store.updateTicket(slug, t.id, { status: "active" }, "self"); // self's own move
  assert.equal(drain(slug, "self").length, 0);
});

test("a non-subscriber receives nothing", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", epic: "Auth" });
  store.setWatch(slug, "w", { epics: ["Other"] });
  store.updateTicket(slug, t.id, { status: "active" }, "x");
  assert.equal(drain(slug, "w").length, 0);
});

test("unwatch removes a filter, or the whole subscription", () => {
  const slug = freshProject();
  store.setWatch(slug, "a", { epics: ["Auth", "Pay"], columns: ["done"] });
  const afterOne = store.unwatch(slug, "a", { epics: ["Auth"] });
  assert.deepEqual(afterOne.epics, ["Pay"]);
  const gone = store.unwatch(slug, "a", { all: true });
  assert.equal(gone, null);
  assert.equal(store.getWatch(slug, "a"), null);
});

test("rejects an actor id that could traverse the filesystem", () => {
  const slug = freshProject();
  assert.throws(() => store.setWatch(slug, "../evil", { epics: ["x"] }), /Invalid actor/);
  assert.throws(() => store.readInbox(slug, "a/b"), /Invalid actor/);
});
