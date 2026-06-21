// HTTP client that mirrors the lib/store.js surface used by cli.js, so the CLI
// can drive a remote clambake server over the LAN instead of touching local
// files. Enabled when CLAMBAKE_URL is set (see cli.js). Every method returns a
// promise; the local store is synchronous, so cli.js awaits both uniformly.
//
// The server has NO authentication — anyone who can reach the port can read and
// write the board. Only expose it on a trusted network.

// Core request: send `opts` to base+pathname and turn the response into either a
// parsed body or a thrown Error, so callers never touch fetch directly.
async function exec(base, pathname, opts) {
  const url = base.replace(/\/+$/, "") + pathname;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`cannot reach clambake at ${base}: ${e.message}`);
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

function req(base, method, pathname, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return exec(base, pathname, opts);
}

export function makeClient(base) {
  const seg = (s) => encodeURIComponent(s);
  return {
    listProjects: () => req(base, "GET", "/api/projects"),
    createProject: (obj) => req(base, "POST", "/api/projects", obj),
    getBoard: (p) => req(base, "GET", `/api/projects/${seg(p)}/board`),

    createTicket: (p, fields, actor) =>
      req(base, "POST", `/api/projects/${seg(p)}/tickets`, { ...fields, actor }),
    updateTicket: (p, id, patch, actor) =>
      req(base, "PATCH", `/api/projects/${seg(p)}/tickets/${seg(id)}`, { ...patch, actor }),
    appendNote: (p, id, text, expectedUpdatedAt, actor) =>
      req(base, "POST", `/api/projects/${seg(p)}/tickets/${seg(id)}/note`, { text, expectedUpdatedAt, actor }),
    deleteTicket: (p, id) =>
      req(base, "DELETE", `/api/projects/${seg(p)}/tickets/${seg(id)}`),

    // No dedicated GET-one endpoint; derive it from the board like the UI does.
    async getTicket(p, id) {
      const board = await req(base, "GET", `/api/projects/${seg(p)}/board`);
      const t = (board.tickets || []).find((x) => x.id === id);
      if (!t) throw new Error(`no such ticket: ${id}`);
      return t;
    },

    // Raw image bytes go in the body; name/actor ride as query params, matching
    // the server's express.raw upload route. Mirrors store.addAttachment.
    addAttachment(p, id, name, buffer, actor) {
      const q = new URLSearchParams({ name });
      if (actor) q.set("actor", actor);
      return exec(base, `/api/projects/${seg(p)}/tickets/${seg(id)}/attachments?${q}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buffer,
      });
    },
    removeAttachment(p, id, filename, actor) {
      const q = actor ? `?actor=${encodeURIComponent(actor)}` : "";
      return exec(base, `/api/projects/${seg(p)}/tickets/${seg(id)}/attachments/${seg(filename)}${q}`, {
        method: "DELETE",
        headers: {},
      });
    },

    listArchived: (p) => req(base, "GET", `/api/projects/${seg(p)}/archive`),
    archiveTicket: (p, id) => req(base, "POST", `/api/projects/${seg(p)}/tickets/${seg(id)}/archive`),
    unarchiveTicket: (p, id) => req(base, "POST", `/api/projects/${seg(p)}/tickets/${seg(id)}/unarchive`),
    sweepArchive(p, { days, dryRun } = {}) {
      const q = new URLSearchParams();
      if (Number.isFinite(days)) q.set("days", String(days));
      if (dryRun) q.set("dryRun", "1");
      const qs = q.toString();
      return req(base, "POST", `/api/projects/${seg(p)}/sweep${qs ? `?${qs}` : ""}`);
    },

    // --- watch subscriptions + inbox ---
    setWatch: (p, actor, filters) => req(base, "PUT", `/api/projects/${seg(p)}/watchers/${seg(actor)}`, filters || {}),
    getWatch: (p, actor) => req(base, "GET", `/api/projects/${seg(p)}/watchers/${seg(actor)}`),
    unwatch: (p, actor, filters) =>
      req(base, "DELETE", `/api/projects/${seg(p)}/watchers/${seg(actor)}`, filters || {}).then((r) => r && r.subscription),
    readInbox(p, actor, { peek } = {}) {
      return req(base, "GET", `/api/projects/${seg(p)}/inbox/${seg(actor)}${peek ? "?peek=1" : ""}`);
    },
    // Long-poll, but never hold a single connection long enough to trip the runtime's
    // fetch headersTimeout (undici defaults to 300s; proxies cap lower). Each request
    // holds at most HOLD_MS server-side; we loop until the caller's total timeoutMs is
    // up. A dropped/idle connection is treated as "no events yet" and simply re-polled,
    // so `wait --timeout <large>` works instead of crashing with `fetch failed`.
    async waitInbox(p, actor, { timeoutMs, peek } = {}) {
      const HOLD_MS = 25_000; // per-connection hold, well under any reasonable cap
      const total = Number.isFinite(timeoutMs) ? timeoutMs : 25_000;
      const deadline = Date.now() + total;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { events: [], timedOut: true };
        const hold = Math.min(HOLD_MS, remaining);
        const q = new URLSearchParams({ timeout: String(hold) });
        if (peek) q.set("peek", "1");
        const started = Date.now();
        try {
          const r = await req(base, "GET", `/api/projects/${seg(p)}/inbox/${seg(actor)}/wait?${q}`);
          if (r && r.events && r.events.length) return r;
          // empty: the server hold elapsed with nothing new — loop until our deadline.
          // If the server returned empty without actually holding (old/misconfigured),
          // don't spin: floor each idle iteration at ~1s.
          const elapsed = Date.now() - started;
          if (elapsed < 1_000) await sleep(Math.min(1_000 - elapsed, Math.max(0, deadline - Date.now())));
        } catch (e) {
          // A connection drop (idle long-poll, proxy/headersTimeout) is not a real error;
          // re-poll. A genuine HTTP error (4xx/5xx) is rethrown.
          if (!/cannot reach/i.test(e.message)) throw e;
          await sleep(500); // avoid a hot loop if the host is briefly unreachable
        }
      }
    },

    listSprints: (p) => req(base, "GET", `/api/projects/${seg(p)}/sprints`),
    createSprint: (p, obj) => req(base, "POST", `/api/projects/${seg(p)}/sprints`, obj),
    updateSprint: (p, id, patch) => req(base, "PATCH", `/api/projects/${seg(p)}/sprints/${seg(id)}`, patch),
    deleteSprint: (p, id) => req(base, "DELETE", `/api/projects/${seg(p)}/sprints/${seg(id)}`),
  };
}
