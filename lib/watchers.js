// Subscriptions registry + per-agent inbox fan-out.
//
// Agents self-register interest in tickets / epics / columns / @mentions; the registry
// lives in data/projects/<slug>/watchers.json. When the store emits an event,
// emitEvent() calls fanout() here, which appends the event to inbox/<actor>.ndjson for
// every subscriber it matches. An agent then just drains its OWN inbox (cursor-tracked,
// durable) — no client-side filtering, no replay of the whole board.
//
// An actor is never notified of its own action (event.actor === actor is skipped), so a
// watcher isn't woken by its own writes without needing an explicit ignore flag.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNdjson } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "..", "data", "projects");

const projDir = (slug) => path.join(DATA_DIR, slug);
const watchersFile = (slug) => path.join(projDir(slug), "watchers.json");
const inboxDir = (slug) => path.join(projDir(slug), "inbox");
const inboxFile = (slug, actor) => path.join(inboxDir(slug), `${safeActor(actor)}.ndjson`);
const cursorFile = (slug, actor) => path.join(inboxDir(slug), `${safeActor(actor)}.cursor`);

// Actor ids name files, so guard against path traversal (same rule as the store's safeSeg).
function safeActor(actor) {
  if (typeof actor !== "string" || !/^[A-Za-z0-9._-]+$/.test(actor) || actor === "." || actor === "..") {
    throw new HttpError(400, `Invalid actor: ${actor}`);
  }
  return actor;
}

// Minimal HttpError mirror so callers (server) get a real status; store has its own copy.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic replace
};

export function getWatchers(slug) {
  try {
    return JSON.parse(fs.readFileSync(watchersFile(slug), "utf8"));
  } catch {
    return {};
  }
}

const emptySub = () => ({ tickets: [], epics: [], columns: [], mentions: false });
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// One actor's subscription, or null if not registered.
export function getWatch(slug, actor) {
  return getWatchers(slug)[safeActor(actor)] || null;
}

// Add (union) interests for an actor. Returns the merged subscription.
export function setWatch(slug, actor, { tickets = [], epics = [], columns = [], mentions = false } = {}) {
  safeActor(actor);
  const all = getWatchers(slug);
  const cur = all[actor] || emptySub();
  const next = {
    tickets: uniq([...cur.tickets, ...tickets]),
    epics: uniq([...cur.epics, ...epics]),
    columns: uniq([...cur.columns, ...columns]),
    mentions: cur.mentions || !!mentions,
  };
  all[actor] = next;
  writeJson(watchersFile(slug), all);
  return next;
}

// Remove interests. With `all`, or with no specific filters given, drop the actor entirely.
export function unwatch(slug, actor, { tickets = [], epics = [], columns = [], mentions = false, all = false } = {}) {
  safeActor(actor);
  const reg = getWatchers(slug);
  const cur = reg[actor];
  if (!cur) return null;
  const nothingSpecified = !tickets.length && !epics.length && !columns.length && !mentions;
  if (all || nothingSpecified) {
    delete reg[actor];
    writeJson(watchersFile(slug), reg);
    return null;
  }
  const without = (a, b) => a.filter((x) => !b.includes(x));
  const next = {
    tickets: without(cur.tickets, tickets),
    epics: without(cur.epics, epics),
    columns: without(cur.columns, columns),
    mentions: mentions ? false : cur.mentions,
  };
  // If the actor now subscribes to nothing, drop them rather than keep an empty record.
  if (!next.tickets.length && !next.epics.length && !next.columns.length && !next.mentions) {
    delete reg[actor];
    writeJson(watchersFile(slug), reg);
    return null;
  }
  reg[actor] = next;
  writeJson(watchersFile(slug), reg);
  return next;
}

// Does this subscription want this event? Column matches the destination of a move /
// the status of a created ticket. Mentions match when the actor is named in event.mentions.
export function subMatches(sub, actor, event) {
  if (!sub) return false;
  if (event.ticket && sub.tickets.includes(event.ticket)) return true;
  if (event.epic && sub.epics.includes(event.epic)) return true;
  const col = event.to || event.status; // moved -> to; created -> status
  if (col && sub.columns.includes(col)) return true;
  if (sub.mentions && Array.isArray(event.mentions) && event.mentions.includes(actor)) return true;
  return false;
}

// Append `event` to the inbox of every subscriber it matches (except its own actor).
export function fanout(slug, event) {
  const reg = getWatchers(slug);
  for (const [actor, sub] of Object.entries(reg)) {
    if (actor === event.actor) continue; // don't notify an actor of its own action
    if (!subMatches(sub, actor, event)) continue;
    try {
      fs.mkdirSync(inboxDir(slug), { recursive: true });
      fs.appendFileSync(inboxFile(slug, actor), JSON.stringify(event) + "\n");
    } catch {}
  }
}

// Drain an actor's inbox from its saved cursor. Returns the new events; advances the
// cursor unless `peek`. Durable + replay-safe: nothing is deleted, the cursor just moves.
export function readInbox(slug, actor, { peek = false } = {}) {
  safeActor(actor);
  let from = 0;
  try {
    from = Number(fs.readFileSync(cursorFile(slug, actor), "utf8")) || 0;
  } catch {}
  const { events, offset } = readNdjson(inboxFile(slug, actor), from);
  if (!peek && offset !== from) {
    try {
      fs.mkdirSync(inboxDir(slug), { recursive: true });
      fs.writeFileSync(cursorFile(slug, actor), String(offset));
    } catch {}
  }
  return { events, offset, unreadFrom: from };
}
