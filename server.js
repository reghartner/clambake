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
      if (out !== undefined) res.json(out);
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

// ---- static UI ----
app.use(express.static(path.join(__dirname, "public")));

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
});

