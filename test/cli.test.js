// Tests for the CLI's write path in remote (CLAMBAKE_URL) mode. We run cli.js as
// a real subprocess against a stub HTTP server that records request bodies, so we
// can assert the optimistic-concurrency wiring: every mutating command reads the
// ticket first, then writes with that updatedAt snapshot, and a 409 from the
// server makes the command exit non-zero (the caller's cue to re-run).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const STAMP = "2026-06-17T00:00:00.000Z";

// Stub server: serves one ticket on the board and records every request. PATCH
// returns `patchStatus` (200 echoes the patch, 409 reports a conflict).
function startStub({ patchStatus = 200 } = {}) {
  const calls = [];
  const ticket = {
    id: "T-1",
    status: "backlog",
    priority: "med",
    sprint: null,
    assignee: null,
    behind: false,
    ac: [{ text: "do thing", done: false }],
    updatedAt: STAMP,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      calls.push({ method: req.method, url: req.url, body: parsed });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url.endsWith("/board")) {
        return res.end(JSON.stringify({ tickets: [ticket], project: { columns: [] } }));
      }
      if (req.method === "PATCH") {
        res.statusCode = patchStatus;
        if (patchStatus === 409) {
          return res.end(JSON.stringify({ error: "Conflict: T-1 changed since you loaded it — reload and reapply." }));
        }
        return res.end(JSON.stringify({ ...ticket, ...parsed }));
      }
      if (req.method === "POST" && req.url.endsWith("/note")) {
        return res.end(JSON.stringify(ticket));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port }))
  );
}

// Must be async (not spawnSync): the stub server runs in this same process, so a
// blocking wait would freeze its event loop and deadlock the child's request.
function runCli(port, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, CLAMBAKE_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A mutating command must GET the board (to read updatedAt) before its write, and
// the write must carry expectedUpdatedAt equal to that snapshot.
test("move reads the snapshot then writes with expectedUpdatedAt", async () => {
  const { server, calls, port } = await startStub();
  try {
    const r = await runCli(port, ["move", "-p", "demo", "T-1", "planned"]);
    assert.equal(r.status, 0, r.stderr);
    const get = calls.find((c) => c.method === "GET");
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(calls.indexOf(get) < calls.indexOf(patch), "GET must precede PATCH");
    assert.equal(patch.body.expectedUpdatedAt, STAMP);
    assert.equal(patch.body.status, "planned");
  } finally {
    server.close();
  }
});

test("update writes with expectedUpdatedAt", async () => {
  const { server, calls, port } = await startStub();
  try {
    const r = await runCli(port, ["update", "-p", "demo", "T-1", "--priority", "high"]);
    assert.equal(r.status, 0, r.stderr);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.equal(patch.body.expectedUpdatedAt, STAMP);
    assert.equal(patch.body.priority, "high");
  } finally {
    server.close();
  }
});

test("ac check writes the modified array with expectedUpdatedAt", async () => {
  const { server, calls, port } = await startStub();
  try {
    const r = await runCli(port, ["ac", "-p", "demo", "T-1", "check", "0"]);
    assert.equal(r.status, 0, r.stderr);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.equal(patch.body.expectedUpdatedAt, STAMP);
    assert.equal(patch.body.ac[0].done, true);
  } finally {
    server.close();
  }
});

test("note writes with expectedUpdatedAt", async () => {
  const { server, calls, port } = await startStub();
  try {
    const r = await runCli(port, ["note", "-p", "demo", "T-1", "hello"]);
    assert.equal(r.status, 0, r.stderr);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/note"));
    assert.equal(post.body.expectedUpdatedAt, STAMP);
    assert.equal(post.body.text, "hello");
  } finally {
    server.close();
  }
});

// attach --link must work over HTTP too: read the board for links+updatedAt, then
// PATCH the merged links[] with the optimistic-concurrency stamp — never an upload.
test("attach --link PATCHes links[] over the HTTP backend", async () => {
  const { server, calls, port } = await startStub();
  try {
    const r = await runCli(port, ["attach", "-p", "demo", "T-1", "--link", "https://example.com/pr/9"]);
    assert.equal(r.status, 0, r.stderr);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "should PATCH the ticket, not upload");
    assert.equal(patch.body.expectedUpdatedAt, STAMP);
    assert.deepEqual(patch.body.links, ["https://example.com/pr/9"]);
    // and it must NOT hit the attachments upload route
    assert.ok(!calls.some((c) => /\/attachments/.test(c.url)), "URL attach must not upload bytes");
  } finally {
    server.close();
  }
});

// A conflicting write (server 409) must fail the command, not pass silently, so a
// scripted caller can detect it and re-run.
test("a 409 conflict makes the command exit non-zero", async () => {
  const { server, port } = await startStub({ patchStatus: 409 });
  try {
    const r = await runCli(port, ["move", "-p", "demo", "T-1", "planned"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Conflict/);
  } finally {
    server.close();
  }
});
