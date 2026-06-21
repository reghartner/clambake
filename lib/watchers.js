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

// Register interests for an actor. Returns the resulting subscription. An optional
// `notify` URL turns on best-effort webhook push for this actor (see fanout); pass
// "none" to clear it.
//
// By DEFAULT this is additive — it UNIONs the given filters onto whatever the actor
// already watches (back-compat: re-running `watch --epic B` keeps A). Pass
// `replace: true` to instead SET the EXACT filter set in one call: epics/tickets/
// columns/mentions are taken verbatim from this call and anything omitted is cleared.
// `notify` is independent of `replace` — it is touched only when explicitly given, so a
// replace that doesn't pass --notify preserves the existing webhook.
export function setWatch(slug, actor, { tickets = [], epics = [], columns = [], mentions = false, notify, replace = false } = {}) {
  safeActor(actor);
  const all = getWatchers(slug);
  const cur = all[actor] || emptySub();
  const next = replace
    ? {
        tickets: uniq(tickets),
        epics: uniq(epics),
        columns: uniq(columns),
        mentions: !!mentions,
      }
    : {
        tickets: uniq([...cur.tickets, ...tickets]),
        epics: uniq([...cur.epics, ...epics]),
        columns: uniq([...cur.columns, ...columns]),
        mentions: cur.mentions || !!mentions,
      };
  if (notify === "none" || notify === "") next.notify = null;
  else if (notify != null) next.notify = validNotify(notify);
  else if (cur.notify) next.notify = cur.notify; // preserve unless explicitly changed/cleared
  all[actor] = next;
  writeJson(watchersFile(slug), all);
  return next;
}

// A webhook URL must be http(s); reject anything else rather than store junk we'd POST to.
function validNotify(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new HttpError(400, `Invalid notify URL (must start with http:// or https://): ${url}`);
  }
  return url;
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
  // Mutate ONLY the named filter(s); carry every unrelated field through unchanged —
  // notably `notify`, which must survive when you only drop an epic/ticket/column.
  const next = {
    ...cur,
    tickets: without(cur.tickets, tickets),
    epics: without(cur.epics, epics),
    columns: without(cur.columns, columns),
    mentions: mentions ? false : cur.mentions,
  };
  // If the actor now subscribes to nothing AND has no webhook left, drop the empty
  // record. A surviving `notify` keeps the record alive (a push-only registration is
  // still meaningful) — removing a filter must not silently delete the webhook.
  if (!next.tickets.length && !next.epics.length && !next.columns.length && !next.mentions && !next.notify) {
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
  const reg = getWatchers(slug);
  const recipients = new Set();
  for (const [actor, sub] of Object.entries(reg)) {
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
    // Best-effort push: if this actor registered a webhook, nudge it. The inbox above is
    // the source of truth, so a dropped push is harmless — it's still there to pull.
    const url = reg[actor] && reg[actor].notify;
    if (url) postWebhook(url, { project: slug, actor, event });
  }
}

// Fire-and-forget POST of an event to a subscriber's webhook. Never awaited (must not slow
// the write path) and never throws (delivery is best-effort; the inbox is durable).
function postWebhook(url, payload) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  } catch {}
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
