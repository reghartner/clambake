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

// Extract @mentions from free text: "@pm please look" -> ["pm"]. Same id charset as
// actors; deduped. Drives "tag someone on a ticket" — no column move required.
export function extractMentions(text) {
  if (!text) return [];
  const out = new Set();
  for (const m of String(text).matchAll(/(?:^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g)) out.add(m[1]);
  return [...out];
}

// Deliver `event` to every recipient's inbox (except its own actor). Recipients =
// registered subscribers it matches, PLUS anyone @mentioned in it — so a mention
// reaches the named actor even if they never registered. Deduped, one line each.
export function fanout(slug, event) {
  const recipients = new Set();
  for (const [actor, sub] of Object.entries(getWatchers(slug))) {
    if (subMatches(sub, actor, event)) recipients.add(actor);
  }
  for (const m of event.mentions || []) recipients.add(m);
  recipients.delete(event.actor); // never notify an actor of its own action
  for (const actor of recipients) {
    try {
      safeActor(actor); // skip a malformed @token rather than throw out of a write path
    } catch {
      continue;
    }
    try {
      fs.mkdirSync(inboxDir(slug), { recursive: true });
      fs.appendFileSync(inboxFile(slug, actor), JSON.stringify(event) + "\n");
    } catch {}
  }
}

// Block until the actor's inbox has new events, then drain (advancing the cursor unless
// `peek`), or resolve empty on timeout. Watches the project dir (where the log + inboxes
// live) and polls as a backstop, so it catches writes from ANY process — server, this
// process, or a separate local CLI. Lets a turn-based agent wait without a watcher fleet:
// the cursor makes back-to-back wait calls gap-free.
export function waitInbox(slug, actor, { timeoutMs = 25_000, peek = false } = {}) {
  safeActor(actor);
  return new Promise((resolve) => {
    let done = false;
    let watcher;
    let poll;
    let timer;
    const cleanup = () => {
      try {
        watcher && watcher.close();
      } catch {}
      clearInterval(poll);
      clearTimeout(timer);
    };
    const finish = (res) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(res);
    };
    const tryRead = () => {
      const r = readInbox(slug, actor, { peek });
      if (r.events.length) finish(r);
    };
    tryRead(); // anything already waiting?
    if (done) return;
    try {
      watcher = fs.watch(projDir(slug), { persistent: false }, tryRead);
    } catch {}
    poll = setInterval(tryRead, 1_000); // backstop for missed fs events
    timer = setTimeout(() => finish({ events: [], timedOut: true }), timeoutMs);
  });
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
