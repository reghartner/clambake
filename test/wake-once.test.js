// Verifies scripts/wake-once.js is a true one-shot: it replies 204 to the first POST and
// then EXITS 0 (its completion is what re-invokes an agent session). We pass the port via
// argv and wait for the "wake-once armed :<port>" stderr line before POSTing, so there are
// no fixed sleeps and the test is deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "wake-once.js");

// Resolve once the child prints "wake-once armed :<port>" on stderr.
function armed(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stderr.on("data", (c) => {
      buf += c;
      const m = buf.match(/wake-once armed :(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`exited before arming (code ${code})`)));
  });
}

function post(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "POST", host: "127.0.0.1", port, path: "/wake" },
      (res) => {
        res.resume(); // drain so the response completes
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ project: "demo", actor: "me", event: { type: "moved" } }));
  });
}

test("wake-once replies 204 and exits 0 on the first POST", async () => {
  // Port unlikely to collide; the child confirms the actual bound port via stderr anyway.
  const child = spawn(process.execPath, [SCRIPT, "53971"], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const port = await armed(child);
    const status = await post(port);
    assert.equal(status, 204, "first POST should get a 204");

    const code = await exited;
    assert.equal(code, 0, "process should exit 0 after the single POST");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
