// Clambake server: REST API over the file-backed store + static board UI.
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./lib/store.js";
import { HttpError } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
// Bind all interfaces so phones/tablets on the same home network can reach it.
// This is LAN-only — it is NOT externally visible unless your router forwards a port.
// Set HOST=127.0.0.1 to restrict back to this machine only.
const HOST = process.env.HOST || "0.0.0.0";

// Wrap an async handler so thrown HttpErrors become clean JSON responses.
function h(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (res.headersSent) return; // handler wrote the response itself
      if (out !== undefined) res.json(out);
      else res.status(204).end(); // never leave the request hanging on an undefined return
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message });
    }
  };
}

// ---- projects ----
app.get("/api/projects", h(() => store.listProjects()));

app.post(
  "/api/projects",
  h((req) => store.createProject(req.body || {}))
);

app.get(
  "/api/projects/:p/board",
  h((req) => store.getBoard(req.params.p))
);

// ---- tickets ----
app.post(
  "/api/projects/:p/tickets",
  h((req) => store.createTicket(req.params.p, req.body || {}, (req.body || {}).actor || "ui"))
);

app.patch(
  "/api/projects/:p/tickets/:id",
  h((req) => store.updateTicket(req.params.p, req.params.id, req.body || {}, (req.body || {}).actor || "ui"))
);

app.post(
  "/api/projects/:p/tickets/:id/note",
  h((req) =>
    store.appendNote(req.params.p, req.params.id, (req.body || {}).text || "", (req.body || {}).expectedUpdatedAt, (req.body || {}).actor || "ui")
  )
);

app.delete(
  "/api/projects/:p/tickets/:id",
  h((req) => store.deleteTicket(req.params.p, req.params.id))
);

// ---- attachments (images) ----
// Upload: raw image bytes in the body, original filename in ?name=. Kept off the
// JSON parser and given a generous limit so screenshots go through.
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

app.post(
  "/api/projects/:p/tickets/:id/attachments",
  express.raw({ type: () => true, limit: "30mb" }),
  h((req) => {
    const name = req.query.name || "image.png";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new store.HttpError(400, "empty upload body");
    }
    return store.addAttachment(req.params.p, req.params.id, name, req.body, req.query.actor || "ui");
  })
);

app.get("/api/projects/:p/tickets/:id/attachments/:file", (req, res) => {
  try {
    const file = store.attachmentFile(req.params.p, req.params.id, req.params.file);
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    // Harden against stored XSS via uploaded SVG: an .svg served as image/svg+xml
    // would run its embedded script if opened directly as a document. `sandbox`
    // (no allow-scripts) blocks that and treats it as a null origin; `nosniff`
    // stops MIME confusion. Images still render fine inline and in a new tab.
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.set("X-Content-Type-Options", "nosniff");
    res.type(type).sendFile(file);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

app.delete(
  "/api/projects/:p/tickets/:id/attachments/:file",
  h((req) => store.removeAttachment(req.params.p, req.params.id, req.params.file, req.query.actor || "ui"))
);

// ---- sprints ----
app.get(
  "/api/projects/:p/sprints",
  h((req) => store.listSprints(req.params.p))
);

app.post(
  "/api/projects/:p/sprints",
  h((req) => store.createSprint(req.params.p, req.body || {}))
);

app.patch(
  "/api/projects/:p/sprints/:id",
  h((req) => store.updateSprint(req.params.p, req.params.id, req.body || {}))
);

app.delete(
  "/api/projects/:p/sprints/:id",
  h((req) => store.deleteSprint(req.params.p, req.params.id))
);

// ---- archive ----
app.get(
  "/api/projects/:p/archive",
  h((req) => store.listArchived(req.params.p))
);

app.post(
  "/api/projects/:p/tickets/:id/archive",
  h((req) => store.archiveTicket(req.params.p, req.params.id))
);

app.post(
  "/api/projects/:p/tickets/:id/unarchive",
  h((req) => store.unarchiveTicket(req.params.p, req.params.id))
);

// Run a sweep now. Optional ?days=N overrides the project's archiveDoneAfterDays;
// ?dryRun=1 reports what would move without touching anything.
app.post(
  "/api/projects/:p/sweep",
  h((req) =>
    store.sweepArchive(req.params.p, {
      days: req.query.days != null ? Number(req.query.days) : undefined,
      dryRun: req.query.dryRun === "1" || req.query.dryRun === "true",
    })
  )
);

// ---- watch subscriptions + inbox ----
// Register/extend an actor's interests (union with whatever it already watches).
app.put(
  "/api/projects/:p/watchers/:actor",
  h((req) => store.setWatch(req.params.p, req.params.actor, req.body || {}))
);
// Inspect an actor's subscription.
app.get(
  "/api/projects/:p/watchers/:actor",
  h((req) => store.getWatch(req.params.p, req.params.actor) || {})
);
// Remove some interests, or the whole subscription (body { all: true } or no filters).
app.delete(
  "/api/projects/:p/watchers/:actor",
  h((req) => ({ subscription: store.unwatch(req.params.p, req.params.actor, req.body || {}) }))
);
// Drain an actor's inbox (advances its cursor unless ?peek=1).
app.get(
  "/api/projects/:p/inbox/:actor",
  h((req) =>
    store.readInbox(req.params.p, req.params.actor, {
      peek: req.query.peek === "1" || req.query.peek === "true",
    })
  )
);

// ---- static UI ----
app.use(express.static(path.join(__dirname, "public")));

// Periodically auto-archive done tickets that have aged past each project's
// archiveDoneAfterDays. Runs on startup and every 10 min; projects that haven't
// opted in are no-ops. Errors are logged, never fatal.
const ARCHIVE_SWEEP_MS = 10 * 60 * 1000;
function sweepArchives() {
  try {
    const moved = store.sweepAllArchives();
    const ids = Object.values(moved).flat();
    if (ids.length) console.log(`auto-archived ${ids.length} ticket(s): ${ids.join(", ")}`);
  } catch (err) {
    console.error("archive sweep failed:", err.message);
  }
}

app.listen(PORT, HOST, () => {
  console.log("Clambake board running:");
  console.log(`  this machine:  http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        console.log(`  on your phone: http://${a.address}:${PORT}`);
      }
    }
  }
  sweepArchives();
  // unref so the timer never keeps the process alive on its own.
  setInterval(sweepArchives, ARCHIVE_SWEEP_MS).unref();
});

