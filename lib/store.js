// File-backed store. Source of truth = markdown files under data/projects/<slug>/.
// Every read parses files fresh (so out-of-band edits by Claude show up live);
// every write is a read-modify-write of a single target file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  normalizeProject,
  normalizeTicket,
  normalizeSprint,
  normalizeAc,
  nextId,
  computeBehind,
  shouldArchive,
  PRIORITIES,
} from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Data lives in <repo>/data/projects by default, or wherever CLAMBAKE_DATA points
// (absolute or relative to cwd). Lets the board drop into any project and keep its
// ticket store outside the repo if you want.
const DATA_DIR = process.env.CLAMBAKE_DATA
  ? path.resolve(process.env.CLAMBAKE_DATA)
  : path.join(__dirname, "..", "data", "projects");

// ---- path helpers ----------------------------------------------------------
function projDir(slug) {
  return path.join(DATA_DIR, slug);
}
function ticketsDir(slug) {
  return path.join(projDir(slug), "tickets");
}
function attachmentsDir(slug, id) {
  return path.join(projDir(slug), "attachments", id);
}
function sprintsDir(slug) {
  return path.join(projDir(slug), "sprints");
}
function archiveDir(slug) {
  return path.join(projDir(slug), "archive");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function nowIso() {
  return new Date().toISOString();
}

// Guard against path traversal in slugs/ids coming over HTTP/CLI.
// The charset alone is not enough: "." and ".." pass /^[A-Za-z0-9._-]+$/ but
// resolve to the current/parent dir, so a crafted segment (or a chain of them
// across slug/id/filename) climbs out of the data tree. Reject them explicitly.
function safeSeg(seg, label = "value") {
  if (typeof seg !== "string" || !/^[A-Za-z0-9._-]+$/.test(seg) || seg === "." || seg === "..") {
    throw new HttpError(400, `Invalid ${label}: ${seg}`);
  }
  return seg;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- serialization ---------------------------------------------------------
// gray-matter's stringify keeps frontmatter + body readable & stable.
function serializeMd(data, body) {
  return matter.stringify(body ? `\n${body.trim()}\n` : "\n", data);
}

// Atomic write: write to a per-process temp file, then rename over the target.
// rename(2) is atomic on the same filesystem, so a concurrent reader (the other
// process — your browser's server vs. the PM's CLI) sees either the whole old
// file or the whole new file, never a torn half-written one.
let tmpCounter = 0;
function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeMd(file, data, body) {
  atomicWrite(file, serializeMd(data, body));
}

function readMd(file) {
  const raw = fs.readFileSync(file, "utf8");
  return matter(raw);
}

// ---- projects --------------------------------------------------------------
export function listProjects() {
  ensureDir(DATA_DIR);
  return fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => getProject(d.name));
}

export function getProject(slug) {
  safeSeg(slug, "project");
  const cfgPath = path.join(projDir(slug), "project.json");
  let raw = {};
  if (fs.existsSync(cfgPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch {
      raw = {};
    }
  } else if (!fs.existsSync(projDir(slug))) {
    throw new HttpError(404, `No such project: ${slug}`);
  }
  return normalizeProject(slug, raw);
}

export function createProject({ slug, name, idPrefix, staleDays, archiveDoneAfterDays, columns }) {
  safeSeg(slug, "project");
  const dir = projDir(slug);
  if (fs.existsSync(dir)) throw new HttpError(409, `Project already exists: ${slug}`);
  ensureDir(ticketsDir(slug));
  ensureDir(sprintsDir(slug));
  const cfg = normalizeProject(slug, { name, idPrefix, staleDays, archiveDoneAfterDays, columns });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify(
      {
        name: cfg.name,
        idPrefix: cfg.idPrefix,
        staleDays: cfg.staleDays,
        archiveDoneAfterDays: cfg.archiveDoneAfterDays,
        columns: cfg.columns,
      },
      null,
      2
    )
  );
  return cfg;
}

// ---- tickets ---------------------------------------------------------------
export function listTickets(slug) {
  safeSeg(slug, "project");
  const dir = ticketsDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, content } = readMd(path.join(dir, f));
      const t = normalizeTicket(data, content);
      if (!t.id) t.id = f.replace(/\.md$/, "");
      return t;
    });
}

export function getTicket(slug, id) {
  safeSeg(slug, "project");
  safeSeg(id, "ticket id");
  const file = path.join(ticketsDir(slug), `${id}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `No such ticket: ${id}`);
  const { data, content } = readMd(file);
  const t = normalizeTicket(data, content);
  if (!t.id) t.id = id;
  return t;
}

function ticketToFrontmatter(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    sprint: t.sprint,
    epic: t.epic,
    priority: t.priority,
    labels: t.labels,
    assignee: t.assignee,
    links: t.links,
    attachments: t.attachments,
    blockedBy: t.blockedBy,
    ac: t.ac,
    dueDate: t.dueDate,
    testSteps: t.testSteps,
    lastActor: t.lastActor,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    doneAt: t.doneAt,
  };
}

function writeTicket(slug, t) {
  const file = path.join(ticketsDir(slug), `${t.id}.md`);
  writeMd(file, ticketToFrontmatter(t), t.body);
  return t;
}

export function createTicket(slug, fields = {}, actor = "ui") {
  const project = getProject(slug);
  validateStatus(project, fields.status || "backlog");
  const ts = nowIso();
  const userId = fields.id ? safeSeg(fields.id, "ticket id") : null;

  // Exclusive create with O_EXCL (flag "wx"): the OS guarantees only one writer
  // wins a given filename atomically. If an auto-allocated id collides with a
  // ticket another process just created, the loser gets EEXIST and retries with
  // the next number — so two concurrent creates can never clobber each other.
  ensureDir(ticketsDir(slug));
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = userId || nextId(listTickets(slug).map((t) => t.id), project.idPrefix);
    const doneAt = (fields.status || "backlog") === "done" ? ts : null;
    const t = normalizeTicket({ ...fields, id, ac: normalizeAc(fields.ac), lastActor: actor, createdAt: ts, updatedAt: ts, doneAt }, fields.body || "");
    const file = path.join(ticketsDir(slug), `${id}.md`);
    try {
      fs.writeFileSync(file, serializeMd(ticketToFrontmatter(t), t.body), { flag: "wx" });
      return t;
    } catch (e) {
      if (e.code === "EEXIST") {
        if (userId) throw new HttpError(409, `Ticket already exists: ${userId}`);
        continue; // auto-id raced another create — recompute and retry
      }
      throw e;
    }
  }
  throw new HttpError(500, "could not allocate a unique ticket id after 100 attempts");
}

// Partial update. Pass any subset of fields. Always bumps updatedAt.
// Optional optimistic-concurrency guard: if patch.expectedUpdatedAt is supplied
// and no longer matches the file on disk, someone else (the PM's CLI, or another
// browser tab) changed it since the caller loaded it — reject instead of
// silently clobbering their change. CLI writes omit this and just win.
export function updateTicket(slug, id, patch = {}, actor = "ui") {
  const project = getProject(slug);
  const t = getTicket(slug, id);
  if (patch.expectedUpdatedAt != null && t.updatedAt !== patch.expectedUpdatedAt) {
    throw new HttpError(409, `Conflict: ${id} changed since you loaded it — reload and reapply.`);
  }
  const prevStatus = t.status;
  const allowed = [
    "title",
    "status",
    "sprint",
    "epic",
    "priority",
    "labels",
    "assignee",
    "links",
    "attachments",
    "blockedBy",
    "ac",
    "dueDate",
    "testSteps",
    "body",
  ];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    if (key === "status") validateStatus(project, patch.status);
    if (key === "priority" && !PRIORITIES.includes(patch.priority)) {
      throw new HttpError(400, `Invalid priority: ${patch.priority}`);
    }
    if (key === "ac") {
      t.ac = normalizeAc(patch.ac);
    } else {
      t[key] = patch[key];
    }
  }
  // Stamp doneAt when the ticket enters "done", clear it when it leaves, so the
  // archive clock measures time-in-done rather than time-since-last-edit.
  if (t.status !== prevStatus) {
    if (t.status === "done") t.doneAt = nowIso();
    else if (prevStatus === "done") t.doneAt = null;
  }
  t.lastActor = actor;
  t.updatedAt = nowIso();
  return writeTicket(slug, t);
}

// Append a timestamped note to the ticket body. Bumps updatedAt.
// Same optional optimistic-concurrency guard as updateTicket.
export function appendNote(slug, id, text, expectedUpdatedAt, actor = "ui") {
  const t = getTicket(slug, id);
  if (expectedUpdatedAt != null && t.updatedAt !== expectedUpdatedAt) {
    throw new HttpError(409, `Conflict: ${id} changed since you loaded it — reload and reapply.`);
  }
  const stamp = nowIso();
  const note = `\n### ${stamp}\n${String(text).trim()}\n`;
  t.body = `${t.body.trimEnd()}\n${note}`.trimStart();
  t.lastActor = actor;
  t.updatedAt = stamp;
  return writeTicket(slug, t);
}

// Save an uploaded image buffer next to the ticket and record it in frontmatter.
// Returns { ticket, filename } (filename may be uniquified if it collided).
export function addAttachment(slug, id, rawName, buffer, actor = "ui") {
  const t = getTicket(slug, id); // 404s if ticket missing
  const dir = attachmentsDir(slug, id);
  ensureDir(dir);
  const filename = uniqueAttachmentName(dir, sanitizeFilename(rawName));
  fs.writeFileSync(path.join(dir, filename), buffer);
  t.attachments = [...t.attachments, filename];
  t.lastActor = actor;
  t.updatedAt = nowIso();
  writeTicket(slug, t);
  return { ticket: t, filename };
}

export function removeAttachment(slug, id, filename, actor = "ui") {
  safeSeg(filename, "attachment");
  const t = getTicket(slug, id);
  const file = path.join(attachmentsDir(slug, id), filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  t.attachments = t.attachments.filter((a) => a !== filename);
  t.lastActor = actor;
  t.updatedAt = nowIso();
  writeTicket(slug, t);
  return t;
}

// Resolve an attachment file path for serving; validates segments and existence.
export function attachmentFile(slug, id, filename) {
  safeSeg(slug, "project");
  safeSeg(id, "ticket id");
  safeSeg(filename, "attachment");
  const file = path.join(attachmentsDir(slug, id), filename);
  if (!fs.existsSync(file)) throw new HttpError(404, `No such attachment: ${filename}`);
  return file;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || "image")).replace(/[^A-Za-z0-9._-]/g, "_");
  return base.replace(/^\.+/, "") || "image.png";
}

function uniqueAttachmentName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${process.pid}${ext}`;
}

export function deleteTicket(slug, id) {
  safeSeg(slug, "project");
  safeSeg(id, "ticket id");
  const file = path.join(ticketsDir(slug), `${id}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `No such ticket: ${id}`);
  fs.unlinkSync(file);
  fs.rmSync(attachmentsDir(slug, id), { recursive: true, force: true });
  return { deleted: id };
}

function validateStatus(project, status) {
  const ok = project.columns.some((c) => c.id === status);
  if (!ok) {
    throw new HttpError(
      400,
      `Invalid status "${status}". Valid: ${project.columns.map((c) => c.id).join(", ")}`
    );
  }
}

// ---- archive ---------------------------------------------------------------
// Archiving moves a ticket's .md out of tickets/ into archive/ so it leaves the
// board but stays recoverable. Attachments are left in place (keyed by id), so
// unarchiving restores the ticket whole.
export function listArchived(slug) {
  safeSeg(slug, "project");
  const dir = archiveDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, content } = readMd(path.join(dir, f));
      const t = normalizeTicket(data, content);
      if (!t.id) t.id = f.replace(/\.md$/, "");
      return t;
    });
}

export function archiveTicket(slug, id) {
  safeSeg(slug, "project");
  safeSeg(id, "ticket id");
  const src = path.join(ticketsDir(slug), `${id}.md`);
  if (!fs.existsSync(src)) throw new HttpError(404, `No such ticket: ${id}`);
  ensureDir(archiveDir(slug));
  fs.renameSync(src, path.join(archiveDir(slug), `${id}.md`));
  return { archived: id };
}

export function unarchiveTicket(slug, id) {
  safeSeg(slug, "project");
  safeSeg(id, "ticket id");
  const src = path.join(archiveDir(slug), `${id}.md`);
  if (!fs.existsSync(src)) throw new HttpError(404, `No such archived ticket: ${id}`);
  const dst = path.join(ticketsDir(slug), `${id}.md`);
  if (fs.existsSync(dst)) throw new HttpError(409, `A live ticket already exists: ${id}`);
  ensureDir(ticketsDir(slug));
  fs.renameSync(src, dst);
  return { unarchived: id };
}

// Archive every done ticket old enough per the project's archiveDoneAfterDays
// (or an explicit `days` override). dryRun reports what would move without
// touching anything. No-op when archiving is disabled and no override given.
export function sweepArchive(slug, { now = new Date(), days, dryRun = false } = {}) {
  const project = getProject(slug);
  const threshold = Number.isFinite(days) ? days : project.archiveDoneAfterDays;
  const eligible = listTickets(slug)
    .filter((t) => shouldArchive(t, threshold, now))
    .map((t) => t.id);
  if (!dryRun) for (const id of eligible) archiveTicket(slug, id);
  return { eligible, archived: dryRun ? [] : eligible, dryRun };
}

// Sweep every project. Used by the server's periodic timer.
export function sweepAllArchives(now = new Date()) {
  const out = {};
  for (const p of listProjects()) {
    const r = sweepArchive(p.slug, { now });
    if (r.archived.length) out[p.slug] = r.archived;
  }
  return out;
}

// ---- sprints ---------------------------------------------------------------
export function listSprints(slug) {
  safeSeg(slug, "project");
  const dir = sprintsDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, content } = readMd(path.join(dir, f));
      const s = normalizeSprint(data, content);
      if (!s.id) s.id = f.replace(/\.md$/, "");
      return s;
    });
}

export function createSprint(slug, fields = {}) {
  safeSeg(slug, "project");
  const id = safeSeg(fields.id || slugify(fields.name) || "sprint", "sprint id");
  const file = path.join(sprintsDir(slug), `${id}.md`);
  if (fs.existsSync(file)) throw new HttpError(409, `Sprint already exists: ${id}`);
  const s = normalizeSprint({ ...fields, id });
  writeMd(file, sprintToFrontmatter(s), s.body);
  return s;
}

export function updateSprint(slug, id, patch = {}) {
  safeSeg(slug, "project");
  safeSeg(id, "sprint id");
  const file = path.join(sprintsDir(slug), `${id}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `No such sprint: ${id}`);
  const { data, content } = readMd(file);
  const s = normalizeSprint(data, content);
  s.id = id;
  for (const key of ["name", "startDate", "endDate", "goal", "status", "body"]) {
    if (key in patch) s[key] = patch[key];
  }
  writeMd(file, sprintToFrontmatter(s), s.body);
  return s;
}

// Delete a sprint. Any ticket pointing at it is unassigned (sprint -> null) so
// no ticket is left referencing a sprint that no longer exists.
export function deleteSprint(slug, id) {
  safeSeg(slug, "project");
  safeSeg(id, "sprint id");
  const file = path.join(sprintsDir(slug), `${id}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `No such sprint: ${id}`);
  let unassigned = 0;
  for (const t of listTickets(slug)) {
    if (t.sprint === id) {
      updateTicket(slug, t.id, { sprint: null });
      unassigned++;
    }
  }
  fs.unlinkSync(file);
  return { deleted: id, unassigned };
}

function sprintToFrontmatter(s) {
  return {
    id: s.id,
    name: s.name,
    startDate: s.startDate,
    endDate: s.endDate,
    goal: s.goal,
    status: s.status,
  };
}

function slugify(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- board view (tickets + sprints + computed behind) ----------------------
export function getBoard(slug) {
  const project = getProject(slug);
  const sprints = listSprints(slug);
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  const now = new Date();
  const tickets = listTickets(slug).map((t) => {
    const sprint = t.sprint ? sprintById.get(t.sprint) : null;
    const { behind, reason } = computeBehind(t, sprint, project.staleDays, now);
    return { ...t, behind, behindReason: reason };
  });
  return { project, sprints, tickets };
}
