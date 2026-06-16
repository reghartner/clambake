// Ticket / sprint shape, defaults, id allocation, and "behind" computation.
// Source of truth lives in markdown files; this module defines the canonical
// in-memory shape and the rules the rest of the app depends on.

export const DEFAULT_COLUMNS = [
  { id: "backlog", name: "Backlog" },
  { id: "planned", name: "Planned" },
  { id: "active", name: "Active" },
  { id: "blocked", name: "Blocked" },
  { id: "testingNeeded", name: "Testing Needed" },
  { id: "needsRework", name: "Needs Rework" },
  { id: "done", name: "Done" },
];

// Columns that count as "finished" — a ticket in one of these is never "behind".
export const DONE_COLUMNS = new Set(["done"]);

export const PRIORITIES = ["low", "med", "high"];

export const DEFAULT_PROJECT = {
  name: "",
  idPrefix: "TICK",
  staleDays: 5,
  columns: DEFAULT_COLUMNS,
};

// Normalize a project.json into a complete config (fills missing fields).
export function normalizeProject(slug, raw = {}) {
  const columns =
    Array.isArray(raw.columns) && raw.columns.length
      ? raw.columns.map((c) =>
          typeof c === "string" ? { id: c, name: c } : { id: c.id, name: c.name || c.id }
        )
      : DEFAULT_COLUMNS;
  return {
    slug,
    name: raw.name || slug,
    idPrefix: raw.idPrefix || slug.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "") || "TICK",
    staleDays: Number.isFinite(raw.staleDays) ? raw.staleDays : DEFAULT_PROJECT.staleDays,
    columns,
  };
}

// Fill a freshly-parsed ticket's frontmatter with safe defaults.
export function normalizeTicket(data = {}, body = "") {
  return {
    id: data.id,
    title: data.title || "(untitled)",
    status: data.status || "backlog",
    sprint: data.sprint ?? null,
    epic: data.epic || "", // loose free-text grouping link

    priority: PRIORITIES.includes(data.priority) ? data.priority : "med",
    labels: Array.isArray(data.labels) ? data.labels : [],
    assignee: data.assignee || "",
    links: Array.isArray(data.links) ? data.links : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
    ac: normalizeAc(data.ac),
    dueDate: data.dueDate ?? null,
    testSteps: data.testSteps || "", // markdown/HTML test instructions for the human
    lastActor: data.lastActor || "ui", // who last wrote (agent id, or "ui" for board/human)
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    body: body || "",
  };
}

// Acceptance criteria accept several shapes: ["text"], [{text,done}], or plain strings.
export function normalizeAc(ac) {
  if (!Array.isArray(ac)) return [];
  return ac.map((item) => {
    if (typeof item === "string") return { text: item, done: false };
    return { text: String(item.text ?? ""), done: Boolean(item.done) };
  });
}

export function normalizeSprint(data = {}, body = "") {
  return {
    id: data.id,
    name: data.name || data.id || "(sprint)",
    startDate: data.startDate ?? null,
    endDate: data.endDate ?? null,
    goal: data.goal || "",
    status: data.status || "active", // active | closed
    body: body || "",
  };
}

// Allocate the next id given existing ids and a prefix, e.g. TICK-13.
export function nextId(existingIds, prefix) {
  let max = 0;
  const re = new RegExp(`^${escapeRe(prefix)}-(\\d+)$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Decide whether a ticket "fell behind" and why.
// Rules: not done AND (its sprint's endDate passed) -> "sprint ended"
//        OR not done AND untouched for >= staleDays -> "stale"
//        Per-ticket dueDate, if set and passed, also flags.
// `now` is an ISO string or Date (injectable for tests).
export function computeBehind(ticket, sprint, staleDays, now = new Date()) {
  if (DONE_COLUMNS.has(ticket.status)) return { behind: false, reason: null };
  const nowMs = new Date(now).getTime();
  const reasons = [];

  if (ticket.dueDate) {
    const due = Date.parse(ticket.dueDate);
    if (Number.isFinite(due) && due < nowMs) reasons.push("past due date");
  }

  if (sprint && sprint.endDate) {
    const end = Date.parse(sprint.endDate);
    if (Number.isFinite(end) && end < nowMs) reasons.push("sprint ended");
  }

  if (Number.isFinite(staleDays) && staleDays > 0 && ticket.updatedAt) {
    const updated = Date.parse(ticket.updatedAt);
    if (Number.isFinite(updated)) {
      const ageDays = (nowMs - updated) / 86_400_000;
      if (ageDays >= staleDays) reasons.push(`stale (${Math.floor(ageDays)}d untouched)`);
    }
  }

  return { behind: reasons.length > 0, reason: reasons.join("; ") || null };
}
