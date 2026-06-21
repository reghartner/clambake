// Append-only per-project event log. Every store mutation emits one structured
// event line to data/projects/<slug>/events.ndjson, so a consumer (the watcher,
// and later the inbox/wait subscription system) can react to ANY change — notes,
// moves, edits, archives — not just status. Both write paths funnel through the
// store, so this captures local-CLI and server (UI / remote-CLI) writes alike.
//
// Consumers track a byte OFFSET into the file as their cursor. Reads only consume
// through the last complete line, so a concurrent append mid-read is never seen
// half-parsed — its partial tail is picked up on the next read.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the data dir exactly like the store, so events land beside the tickets.
const DATA_DIR = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "..", "data", "projects");

export function eventsFile(slug) {
  return path.join(DATA_DIR, slug, "events.ndjson");
}

// Append an event. Best-effort: logging must never break the underlying write,
// so any failure is swallowed. A `ts` is stamped if the caller didn't supply one.
export function emitEvent(slug, event) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFileSync(eventsFile(slug), line);
  } catch {}
}

// Current end-of-file byte offset (a fresh consumer starts here to skip history).
export function eventOffset(slug) {
  try {
    return fs.statSync(eventsFile(slug)).size;
  } catch {
    return 0;
  }
}

// Read events appended since byte offset `from`. Returns { events, offset } where
// offset is the new cursor. Only whole lines are consumed; a partial trailing line
// (a concurrent append) is left for next time.
export function readEvents(slug, from = 0) {
  let fd;
  try {
    fd = fs.openSync(eventsFile(slug), "r");
  } catch {
    return { events: [], offset: from };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { events: [], offset: from }; // nothing new (or file truncated/rotated)
    const len = size - from;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const nl = buf.lastIndexOf(0x0a); // 0x0a = '\n'
    if (nl === -1) return { events: [], offset: from }; // no complete line yet
    const consumed = nl + 1;
    const events = buf
      .toString("utf8", 0, consumed)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { events, offset: from + consumed };
  } finally {
    fs.closeSync(fd);
  }
}
