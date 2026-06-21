#!/usr/bin/env node
// wake-once.js — a one-shot HTTP listener: THE real event-driven wake for an agent session.
//
// WHY THIS EXISTS
// ---------------
// clambake's `cli.js watch --notify <url>` fire-and-forgets a POST {project, actor, event}
// to your URL on each matching event (see lib/watchers.js postWebhook). It's tempting to
// point that at a long-lived, log-writing receiver and treat the logfile as a "wake sink".
// That CANNOT wake a Claude agent session. The harness re-invokes a session only when a
// background task THAT SESSION launched COMPLETES. A long-lived receiver never completes,
// so it can never re-enter the session — a logfile sitting there is not a wake.
//
// THE MECHANISM
// -------------
// This script is the opposite: a tiny server the session backgrounds itself. On the FIRST
// request it replies 204, closes the server, and EXITS 0. That exit is the completion of a
// background task the session launched, which is exactly what re-invokes the session. The
// woken session then RE-ARMS this one-shot FIRST and THEN drains its inbox. That order is
// load-bearing: an event landing in the exit->re-arm window has its POST dropped (dead socket),
// but fanout already wrote it to the inbox, so re-arming before draining lets the same turn's
// drain catch it. Worst case is one extra wake, never a missed event. Pull-on-turn
// (`cli.js inbox`) stays the durable source of truth; this push path is the optional
// event-driven upgrade that removes the idle wait. (See docs/agent-guide.md "Event-driven wake".)
//
// CAVEATS
// -------
// 1. Port must be UNIQUE PER ACTOR/SESSION. Multiple actors sharing one port collide.
// 2. The `--notify` URL is resolved on the clambake-SERVER host, not your machine. The
//    server is what sends the POST, so localhost/127.0.0.1 is the SERVER's loopback and the
//    port must be reachable FROM the server box. When server and agent share a host, plain
//    `http://localhost:<uniquePort>/wake` works; otherwise use a server-reachable host:port.
//
// USAGE
//   node scripts/wake-once.js [port]          # port via argv, or env WAKE_PORT, default 9876
//   node scripts/wake-once.js 9876 &          # background it from your session each turn
//   cli.js watch -p <proj> --actor <you> ... --notify http://localhost:9876/wake
//
// It logs "wake-once armed :<port>" to stderr once it is listening.
import http from "node:http";

const PORT = Number(process.env.WAKE_PORT || process.argv[2] || 9876);

const server = http.createServer((req, res) => {
  res.writeHead(204);
  res.end();
  server.close(() => process.exit(0)); // exit on the FIRST request -> re-invokes the session
});

server.listen(PORT, () => process.stderr.write(`wake-once armed :${PORT}\n`));
