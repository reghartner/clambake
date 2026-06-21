// Tests for @mention routing: extraction, and unconditional delivery to the mentioned
// actor's inbox (even if they never registered). Temp CLAMBAKE_DATA before import.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-mentions-"));
process.env.CLAMBAKE_DATA = DATA;

const store = await import("../lib/store.js");
const { extractMentions } = await import("../lib/watchers.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
const freshProject = () => {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
};
const drain = (slug, actor) => store.readInbox(slug, actor).events;

test("extractMentions pulls @ids, dedupes, ignores emails", () => {
  assert.deepEqual(extractMentions("hi @pm and @coder-1, also @pm again"), ["pm", "coder-1"]);
  assert.deepEqual(extractMentions("no mentions here"), []);
  assert.deepEqual(extractMentions("mail foo@bar.com is not a mention"), []);
  assert.deepEqual(extractMentions(""), []);
});

test("a @mention in a note reaches the named actor even if unregistered", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.appendNote(slug, t.id, "@pm please decide", undefined, "coder-1");
  const inbox = drain(slug, "pm");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].type, "noted");
  assert.deepEqual(inbox[0].mentions, ["pm"]);
});

test("self-mention does not notify the author", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" });
  store.appendNote(slug, t.id, "@pm note to self", undefined, "pm");
  assert.equal(drain(slug, "pm").length, 0);
});

test("a mention in a new ticket body notifies", () => {
  const slug = freshProject();
  store.createTicket(slug, { title: "x", body: "cc @reviewer for eyes" }, "author");
  const inbox = drain(slug, "reviewer");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].type, "created");
});

test("edited mentions only fire when the body changes", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x" }, "author");
  store.updateTicket(slug, t.id, { assignee: "z" }, "author"); // no body change
  assert.equal(drain(slug, "qa").length, 0);
  store.updateTicket(slug, t.id, { body: "ping @qa to verify" }, "author");
  const inbox = drain(slug, "qa");
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0].mentions, ["qa"]);
});

test("a mention and a subscription to the same event deliver only once", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", epic: "Auth" });
  store.setWatch(slug, "pm", { epics: ["Auth"] }); // pm also subscribes to the epic
  store.appendNote(slug, t.id, "@pm look", undefined, "coder-1");
  assert.equal(drain(slug, "pm").length, 1, "deduped to a single inbox line");
});
