// Tests the HTTP client's waitInbox looping: it polls short holds up to the caller's total
// timeout, returns as soon as events arrive, treats a dropped connection as "re-poll" (not
// a crash), and returns a clean empty result on timeout. Uses a stub HTTP server so we
// control empties / drops deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeClient } from "../lib/api-client.js";

// Spin a stub server whose /wait handler is supplied per-test. Returns { base, close, count }.
function stub(onWait) {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url.includes("/wait")) {
      count++;
      onWait(count, req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        getCount: () => count,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
const json = (res, obj) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("loops past empty holds and returns when events arrive", async () => {
  const s = await stub((n, req, res) => {
    if (n < 3) return json(res, { events: [] }); // first two holds: nothing
    json(res, { events: [{ type: "noted", ticket: "T-1", actor: "x" }] });
  });
  try {
    const client = makeClient(s.base);
    const r = await client.waitInbox("demo", "me", { timeoutMs: 10_000 });
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].ticket, "T-1");
    assert.ok(s.getCount() >= 3, "should have re-polled past the empties");
  } finally {
    await s.close();
  }
});

test("a dropped connection is re-polled, not thrown", async () => {
  const s = await stub((n, req, res) => {
    if (n === 1) return res.destroy(); // simulate the headersTimeout/socket drop
    json(res, { events: [{ type: "moved", ticket: "T-2", actor: "x" }] });
  });
  try {
    const client = makeClient(s.base);
    const r = await client.waitInbox("demo", "me", { timeoutMs: 10_000 });
    assert.equal(r.events[0].ticket, "T-2");
  } finally {
    await s.close();
  }
});

test("returns a clean empty result on total timeout (no throw)", async () => {
  const s = await stub((n, req, res) => json(res, { events: [] })); // always empty
  try {
    const client = makeClient(s.base);
    const r = await client.waitInbox("demo", "me", { timeoutMs: 300 });
    assert.deepEqual(r.events, []);
    assert.equal(r.timedOut, true);
  } finally {
    await s.close();
  }
});

test("a genuine HTTP error is surfaced, not swallowed", async () => {
  const s = await stub((n, req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  try {
    const client = makeClient(s.base);
    await assert.rejects(() => client.waitInbox("demo", "me", { timeoutMs: 5_000 }), /boom/);
  } finally {
    await s.close();
  }
});
