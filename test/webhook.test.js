// Tests the optional webhook push: setWatch stores/validates a notify URL, fanout fires a
// best-effort POST to a subscriber's webhook, the inbox is still written (push is a nudge,
// not the source of truth), and a dead webhook never breaks the write. Temp CLAMBAKE_DATA.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-webhook-"));
process.env.CLAMBAKE_DATA = DATA;

const store = await import("../lib/store.js");

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let n = 0;
const freshProject = () => {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T" });
  return slug;
};

// A stub webhook server that resolves `next()` with the next POSTed payload.
function webhook() {
  let resolve;
  const got = new Promise((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok");
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(body);
      }
    });
  });
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      ready({ url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => server.close() });
    });
  });
}

test("setWatch validates the notify URL", () => {
  const slug = freshProject();
  assert.throws(() => store.setWatch(slug, "a", { epics: ["X"], notify: "ftp://nope" }), /Invalid notify URL/);
  const sub = store.setWatch(slug, "a", { epics: ["X"], notify: "http://example.test/h" });
  assert.equal(sub.notify, "http://example.test/h");
  // "none" clears it, interests preserved.
  const cleared = store.setWatch(slug, "a", { notify: "none" });
  assert.equal(cleared.notify, null);
  assert.deepEqual(cleared.epics, ["X"]);
});

test("fanout POSTs the event to a subscriber's webhook, and still writes the inbox", async () => {
  const slug = freshProject();
  const hook = await webhook();
  try {
    const t = store.createTicket(slug, { title: "x", epic: "Auth" });
    store.setWatch(slug, "coder-2", { epics: ["Auth"], notify: hook.url });
    store.updateTicket(slug, t.id, { status: "active" }, "someone");

    const payload = await hook.got; // push arrived
    assert.equal(payload.actor, "coder-2");
    assert.equal(payload.event.type, "moved");
    assert.equal(payload.event.to, "active");

    // inbox is still the durable record
    const inbox = store.readInbox(slug, "coder-2").events;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].type, "moved");
  } finally {
    hook.close();
  }
});

test("a dead webhook URL does not break the write or the inbox", () => {
  const slug = freshProject();
  const t = store.createTicket(slug, { title: "x", epic: "Auth" });
  // Nothing listening on this port — the POST will fail, silently.
  store.setWatch(slug, "coder-2", { epics: ["Auth"], notify: "http://127.0.0.1:9/hook" });
  assert.doesNotThrow(() => store.updateTicket(slug, t.id, { status: "active" }, "someone"));
  assert.equal(store.readInbox(slug, "coder-2").events.length, 1);
});
