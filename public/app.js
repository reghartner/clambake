// Clambake board frontend. Vanilla JS, no build step.
// Polls the board every ~4s so edits Claude makes on disk appear live.

const POLL_MS = 4000;
const state = {
  project: localStorage.getItem("clambake.project") || null,
  board: null, // { project, sprints, tickets }
  sprintFilter: "",
  epicFilter: "",
  behindOnly: false,
  search: "",
  modalId: null, // open ticket id, or null
  dirty: false, // suppress poll re-render while editing a field
};

// ---- API helpers -----------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || res.statusText);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

const el = (id) => document.getElementById(id);
function isInteracting() {
  const a = document.activeElement;
  return !!a && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName);
}
function setStatus(msg) {
  el("status").textContent = msg;
}

// ---- bootstrap -------------------------------------------------------------
async function init() {
  bindTopbar();
  await loadProjects();
  await refresh();
  setInterval(() => {
    // Skip the poll while a control is focused (e.g. an open dropdown) — re-rendering
    // mid-interaction tears down the element and drops the click.
    if (!state.dirty && !isInteracting()) refresh();
  }, POLL_MS);
}

async function loadProjects() {
  const projects = await api("GET", "/api/projects");
  const sel = el("projectSelect");
  sel.innerHTML = "";
  if (!projects.length) {
    const o = document.createElement("option");
    o.textContent = "(no projects — create one)";
    o.value = "";
    sel.appendChild(o);
    state.project = null;
    return;
  }
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.slug;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  if (!state.project || !projects.some((p) => p.slug === state.project)) {
    state.project = projects[0].slug;
  }
  sel.value = state.project;
}

async function refresh() {
  if (!state.project) {
    el("board").innerHTML = `<div class="muted" style="padding:20px">No project selected. Click "+ Project".</div>`;
    return;
  }
  try {
    state.board = await api("GET", `/api/projects/${state.project}/board`);
    render();
    setStatus(`updated ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`⚠ ${e.message}`);
  }
}

// ---- render ----------------------------------------------------------------
function distinctEpics() {
  return [...new Set(state.board.tickets.map((t) => t.epic).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function visibleTickets() {
  let list = state.board.tickets;
  if (state.sprintFilter) list = list.filter((t) => t.sprint === state.sprintFilter);
  if (state.epicFilter) list = list.filter((t) => t.epic === state.epicFilter);
  if (state.behindOnly) list = list.filter((t) => t.behind);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.labels || []).some((l) => String(l).toLowerCase().includes(q))
    );
  }
  return list;
}

function render() {
  renderSprintFilter();
  renderEpicFilter();
  const board = el("board");
  board.innerHTML = "";
  // Sort so same-epic tickets cluster within each column (epicless last), then by id.
  const tickets = visibleTickets().sort(
    (a, b) =>
      (a.epic || "~").localeCompare(b.epic || "~") || a.id.localeCompare(b.id, undefined, { numeric: true })
  );
  for (const col of state.board.project.columns) {
    const inCol = tickets.filter((t) => t.status === col.id);
    board.appendChild(renderColumn(col, inCol));
  }
  if (state.modalId) {
    const t = state.board.tickets.find((x) => x.id === state.modalId);
    if (t) openModal(t);
    else closeModal();
  }
}

function renderSprintFilter() {
  const sel = el("sprintFilter");
  if (document.activeElement === sel) return; // don't tear down an open dropdown
  const cur = sel.value;
  sel.innerHTML = `<option value="">All sprints</option>`;
  for (const s of state.board.sprints) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `${s.name}${s.status === "closed" ? " (closed)" : ""}`;
    sel.appendChild(o);
  }
  sel.value = state.sprintFilter || cur || "";
}

function renderEpicFilter() {
  const sel = el("epicFilter");
  if (document.activeElement === sel) return; // don't tear down an open dropdown
  const cur = sel.value;
  sel.innerHTML = `<option value="">All epics</option>`;
  for (const e of distinctEpics()) {
    const o = document.createElement("option");
    o.value = e;
    o.textContent = e;
    sel.appendChild(o);
  }
  sel.value = state.epicFilter || cur || "";
}

function renderColumn(col, tickets) {
  const wrap = document.createElement("div");
  wrap.className = "column";
  wrap.dataset.col = col.id;

  const head = document.createElement("div");
  head.className = "col-head";
  head.innerHTML = `<span>${col.name}</span><span class="col-count">${tickets.length}</span>`;
  wrap.appendChild(head);

  const bodyEl = document.createElement("div");
  bodyEl.className = "col-body";
  for (const t of tickets) bodyEl.appendChild(renderCard(t));
  wrap.appendChild(bodyEl);

  // drag-drop target
  wrap.addEventListener("dragover", (e) => {
    e.preventDefault();
    wrap.classList.add("dragover");
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    wrap.classList.remove("dragover");
    const id = e.dataTransfer.getData("text/plain");
    const t = state.board.tickets.find((x) => x.id === id);
    if (t && t.status !== col.id) {
      try {
        await api("PATCH", `/api/projects/${state.project}/tickets/${id}`, {
          status: col.id,
          expectedUpdatedAt: t.updatedAt,
        });
        await refresh();
        toast(`${id} moved`, `→ ${col.name}`, "success");
      } catch (err) {
        if (err.status === 409) {
          toast(`${id} changed underneath you`, "Reloaded latest — try the move again", "error");
          await refresh();
        } else {
          toast("Move failed", err.message, "error");
        }
      }
    }
  });

  return wrap;
}

function renderCard(t) {
  const card = document.createElement("div");
  card.className = `card pri-${t.priority}${t.behind ? " behind" : ""}`;
  card.draggable = true;
  card.dataset.id = t.id;

  const acDone = (t.ac || []).filter((a) => a.done).length;
  const acTotal = (t.ac || []).length;
  const chips = [];
  if (t.epic)
    chips.push(`<span class="chip epic clickable" data-epic="${escapeAttr(t.epic)}" title="filter by this epic">⛰ ${escapeHtml(t.epic)}</span>`);
  if (t.sprint)
    chips.push(`<span class="chip clickable" data-sprint="${escapeAttr(t.sprint)}" title="filter by this sprint">${escapeHtml(sprintName(t.sprint))}</span>`);
  if (acTotal) chips.push(`<span class="chip ac${acDone === acTotal ? " complete" : ""}">AC ${acDone}/${acTotal}</span>`);
  if (t.assignee) chips.push(`<span class="chip assignee">@${escapeHtml(t.assignee)}</span>`);
  if ((t.attachments || []).length) chips.push(`<span class="chip">📎 ${t.attachments.length}</span>`);
  if (t.testSteps && t.testSteps.trim()) chips.push(`<span class="chip">🧪 steps</span>`);
  for (const l of t.labels || []) chips.push(`<span class="chip">${escapeHtml(l)}</span>`);
  if (t.behind) chips.push(`<span class="chip behind" title="${escapeHtml(t.behindReason || "")}">⚠ behind</span>`);

  card.innerHTML = `
    <div class="card-id">${escapeHtml(t.id)}</div>
    <div class="card-title">${escapeHtml(t.title)}</div>
    <div class="card-meta">${chips.join("")}</div>`;

  card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", t.id));
  card.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip.clickable");
    if (chip && chip.dataset.epic != null) {
      state.epicFilter = chip.dataset.epic;
      el("epicFilter").value = state.epicFilter;
      render();
      toast("Filtered", `Epic: ${chip.dataset.epic}`, "info");
      return;
    }
    if (chip && chip.dataset.sprint != null) {
      state.sprintFilter = chip.dataset.sprint;
      el("sprintFilter").value = state.sprintFilter;
      render();
      toast("Filtered", `Sprint: ${sprintName(chip.dataset.sprint)}`, "info");
      return;
    }
    state.modalId = t.id;
    openModal(t);
  });
  return card;
}

function sprintName(id) {
  const s = state.board.sprints.find((x) => x.id === id);
  return s ? s.name : id;
}

// ---- modal -----------------------------------------------------------------
function openModal(t) {
  const cols = state.board.project.columns;
  const sprints = state.board.sprints;
  const body = el("modalBody");

  const notes = parseNotes(t.body);

  // Local working copies — AC + links are STAGED here and only persisted on Save,
  // so toggling a checkbox no longer writes to disk on its own.
  const acDraft = (t.ac || []).map((a) => ({ ...a }));
  const linksDraft = (t.links || []).slice();
  let attachState = (t.attachments || []).slice(); // attachments upload immediately

  body.innerHTML = `
    ${t.behind ? `<div class="behind-banner">⚠ Behind: ${escapeHtml(t.behindReason || "")}</div>` : ""}
    <div class="card-id">${escapeHtml(t.id)}</div>
    <input id="m_title" class="m-field" value="${escapeAttr(t.title)}" style="width:100%;font-size:18px;font-weight:600;margin:4px 0 10px;background:transparent;border:none;color:var(--text)" />

    <div class="row">
      <div class="field"><label>Status</label>
        <select id="m_status">${cols.map((c) => opt(c.id, c.name, t.status)).join("")}</select></div>
      <div class="field"><label>Priority</label>
        <select id="m_priority">${["high", "med", "low"].map((p) => opt(p, p, t.priority)).join("")}</select></div>
    </div>

    <div class="row">
      <div class="field"><label>Sprint</label>
        <select id="m_sprint"><option value="">— none —</option>${sprints
          .map((s) => opt(s.id, s.name, t.sprint || ""))
          .join("")}</select></div>
      <div class="field"><label>Assignee</label>
        <input id="m_assignee" value="${escapeAttr(t.assignee || "")}" placeholder="agent or person" /></div>
    </div>

    <div class="field"><label>Epic <span class="muted">(loose group for sorting/filtering)</span></label>
      <input id="m_epic" list="m_epic_list" value="${escapeAttr(t.epic || "")}" placeholder="e.g. onboarding, audio-engine" />
      <datalist id="m_epic_list">${distinctEpics()
        .map((e) => `<option value="${escapeAttr(e)}"></option>`)
        .join("")}</datalist>
    </div>

    <div class="row">
      <div class="field"><label>Labels (comma-sep)</label>
        <input id="m_labels" value="${escapeAttr((t.labels || []).join(", "))}" /></div>
      <div class="field"><label>Due date</label>
        <input id="m_due" type="date" value="${t.dueDate ? String(t.dueDate).slice(0, 10) : ""}" /></div>
    </div>

    <div class="field"><label>Acceptance criteria <span class="muted">(saved with the Save button)</span></label>
      <ul class="ac-list" id="m_ac"></ul>
      <div class="add-inline">
        <input id="m_ac_new" placeholder="add acceptance criterion + Enter" />
      </div>
    </div>

    <div class="field"><label>Test steps <span class="muted">(markdown — for verifying; saved with the Save button)</span></label>
      <div id="m_teststeps_view" class="md-render"></div>
      <details class="ts-edit"${t.testSteps ? "" : " open"}>
        <summary>Edit test steps</summary>
        <textarea id="m_teststeps" rows="8" placeholder="## Setup&#10;1. ...&#10;&#10;## Steps&#10;1. ...&#10;&#10;**Expected:** ...">${escapeHtml(t.testSteps || "")}</textarea>
      </details>
    </div>

    <div class="field"><label>Links <span class="muted">(saved with the Save button)</span></label>
      <div id="m_links"></div>
      <div class="add-inline"><input id="m_link_new" placeholder="add link (url) + Enter" /></div>
    </div>

    <div class="field"><label>Screenshots / attachments</label>
      <div id="m_drop" class="dropzone">Drop or paste an image here, or <label class="link browse">browse<input id="m_file" type="file" accept="image/*" multiple hidden /></label></div>
      <div id="m_attach" class="attach-grid"></div>
    </div>

    <div class="field"><label>Notes</label>
      <div id="m_notes">${notes.map(renderNote).join("") || '<span class="muted">no notes yet</span>'}</div>
      <div class="add-note">
        <textarea id="m_note_new" rows="5" placeholder="write a note…  (⌘/Ctrl+Enter to add)"></textarea>
        <button class="btn sm primary" id="m_note_add">Add note</button>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn primary" id="m_save">Save</button>
      <button class="btn" id="m_cancel">Close</button>
      <button class="btn danger" id="m_delete">Delete</button>
    </div>`;

  el("modal").classList.remove("hidden");

  // track editing so polling won't clobber unsaved edits
  body.querySelectorAll("input, select, textarea").forEach((node) => {
    node.addEventListener("focus", () => (state.dirty = true));
  });

  // ---- AC: staged in acDraft, rendered locally, persisted only on Save ----
  function renderAc() {
    const ul = el("m_ac");
    ul.innerHTML =
      acDraft
        .map(
          (a, i) => `<li class="${a.done ? "done" : ""}">
            <input type="checkbox" data-i="${i}" ${a.done ? "checked" : ""} />
            <input type="text" class="ac-text" data-i="${i}" value="${escapeAttr(a.text)}" />
            <button class="del" data-i="${i}" title="remove">✕</button>
          </li>`
        )
        .join("") || '<li class="muted">none yet</li>';
    ul.querySelectorAll("input[type=checkbox]").forEach((cb) =>
      cb.addEventListener("change", () => {
        acDraft[+cb.dataset.i].done = cb.checked;
        state.dirty = true;
        renderAc(); // local only — no network until Save
      })
    );
    // Edit AC text inline — update the draft only (no re-render, cursor stays); saved on Save.
    ul.querySelectorAll(".ac-text").forEach((inp) =>
      inp.addEventListener("input", () => {
        acDraft[+inp.dataset.i].text = inp.value;
        state.dirty = true;
      })
    );
    ul.querySelectorAll(".del").forEach((btn) =>
      btn.addEventListener("click", () => {
        acDraft.splice(+btn.dataset.i, 1);
        state.dirty = true;
        renderAc();
      })
    );
  }

  // ---- Links: also staged until Save ----
  function renderLinks() {
    const box = el("m_links");
    box.innerHTML = linksDraft.length
      ? linksDraft
          .map(
            (l, i) =>
              `<div class="link-row"><a class="link" href="${escapeAttr(l)}" target="_blank">${escapeHtml(l)}</a><button class="del" data-i="${i}" title="remove">✕</button></div>`
          )
          .join("")
      : '<span class="muted">none</span>';
    box.querySelectorAll(".del").forEach((btn) =>
      btn.addEventListener("click", () => {
        linksDraft.splice(+btn.dataset.i, 1);
        state.dirty = true;
        renderLinks();
      })
    );
  }

  renderAc();
  renderLinks();

  // ---- Test steps: markdown rendered for reading; staged + saved on Save ----
  function renderTestSteps(src) {
    el("m_teststeps_view").innerHTML = src && src.trim() ? renderMd(src) : '<span class="muted">none yet</span>';
  }
  renderTestSteps(t.testSteps);
  el("m_teststeps").addEventListener("input", (e) => {
    state.dirty = true;
    renderTestSteps(e.target.value);
  });
  onEnter("m_ac_new", (val) => {
    acDraft.push({ text: val, done: false });
    state.dirty = true;
    renderAc();
  });
  onEnter("m_link_new", (val) => {
    linksDraft.push(val);
    state.dirty = true;
    renderLinks();
  });

  // ---- Attachments: upload immediately (a file must be persisted), show thumbs ----
  const attUrl = (f) => `/api/projects/${state.project}/tickets/${t.id}/attachments/${encodeURIComponent(f)}`;
  function renderAttach() {
    const grid = el("m_attach");
    grid.innerHTML = attachState.length
      ? attachState
          .map(
            (f) => `<div class="thumb">
              <a href="${attUrl(f)}" target="_blank"><img src="${attUrl(f)}" alt="${escapeAttr(f)}" loading="lazy" /></a>
              <button class="del" data-f="${escapeAttr(f)}" title="remove">✕</button>
            </div>`
          )
          .join("")
      : '<span class="muted">none</span>';
    grid.querySelectorAll(".del").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const f = btn.dataset.f;
        try {
          const updated = await api("DELETE", attUrl(f));
          t.updatedAt = updated.updatedAt;
          attachState = attachState.filter((x) => x !== f);
          renderAttach();
          toast("Attachment removed", "", "success");
        } catch (e) {
          toast("Remove failed", e.message, "error");
        }
      })
    );
  }
  renderAttach();

  async function uploadFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const buf = await file.arrayBuffer();
        const uploadUrl = `/api/projects/${state.project}/tickets/${t.id}/attachments?name=${encodeURIComponent(file.name || "pasted.png")}`;
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: buf,
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(e.error || res.statusText);
        }
        const data = await res.json(); // { ticket, filename }
        t.updatedAt = data.ticket.updatedAt; // keep Save's optimistic token fresh
        attachState.push(data.filename);
        renderAttach();
        toast("Screenshot added", data.filename, "success");
      } catch (e) {
        toast("Upload failed", e.message, "error");
      }
    }
  }

  // Drag/drop + paste are bound ONCE at the window/document level (see bindTopbar)
  // and routed to the open ticket via state.attach. Binding them per-open (the modal
  // re-renders every poll) would stack listeners and upload the same image N times.
  state.attach = { upload: uploadFiles };
  el("m_file").addEventListener("change", (e) => {
    if (e.target.files?.length) uploadFiles(e.target.files);
    e.target.value = "";
  });

  // Notes are a log — posting one is purely additive (it can never clobber another
  // edit), so it is NOT optimistic-concurrency guarded: a note always saves, even if
  // someone (e.g. the PM) just changed the ticket. Appended locally so any STAGED
  // AC/links survive.
  async function addNote() {
    const node = el("m_note_new");
    const val = node.value.trim();
    if (!val) return;
    try {
      const updated = await api("POST", `/api/projects/${state.project}/tickets/${t.id}/note`, { text: val });
      t.updatedAt = updated.updatedAt; // keep Save's optimistic token fresh
      node.value = "";
      const box = el("m_notes");
      if (box.querySelector(".muted")) box.innerHTML = "";
      box.insertAdjacentHTML("afterbegin", renderNote({ ts: updated.updatedAt, text: val }));
      toast(`Note added to ${t.id}`, "", "success");
    } catch (e) {
      toast("Note failed", e.message, "error");
    }
  }
  el("m_note_add").onclick = addNote;
  el("m_note_new").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      addNote();
    }
  });

  el("m_save").onclick = saveModal;
  el("m_cancel").onclick = closeModal;
  el("m_delete").onclick = async () => {
    if (!confirm(`Delete ${t.id}?`)) return;
    try {
      await api("DELETE", `/api/projects/${state.project}/tickets/${t.id}`);
      closeModal();
      await refresh();
      toast(`Deleted ${t.id}`, "", "success");
    } catch (e) {
      toast("Delete failed", e.message, "error");
    }
  };

  async function patch(p) {
    try {
      // expectedUpdatedAt = the snapshot this modal was rendered from; the server
      // rejects with 409 if the ticket changed underneath us (e.g. PM's CLI).
      await api("PATCH", `/api/projects/${state.project}/tickets/${t.id}`, { ...p, expectedUpdatedAt: t.updatedAt });
      state.dirty = false;
      await refresh();
    } catch (e) {
      if (e.status === 409) {
        toast("Changed underneath you", "Reloaded latest — reapply your edit", "error");
        state.dirty = false;
        await refresh();
      } else {
        toast("Save failed", e.message, "error");
      }
      throw e;
    }
  }

  async function saveModal() {
    const labels = el("m_labels").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sprintId = el("m_sprint").value || null;
    const statusId = el("m_status").value;
    await patch({
      title: el("m_title").value.trim() || t.title,
      status: statusId,
      priority: el("m_priority").value,
      sprint: sprintId,
      epic: el("m_epic").value.trim(),
      assignee: el("m_assignee").value.trim(),
      labels,
      dueDate: el("m_due").value || null,
      testSteps: el("m_teststeps").value,
      ac: acDraft,
      links: linksDraft,
    });
    const colName = (state.board.project.columns.find((c) => c.id === statusId) || {}).name || statusId;
    const sprintLabel = sprintId ? sprintName(sprintId) : "no sprint";
    toast(`Saved ${t.id}`, `${sprintLabel} · ${colName}`, "success");
  }
}

function onEnter(id, fn) {
  const node = el(id);
  if (!node) return;
  node.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && node.value.trim()) {
      const v = node.value.trim();
      node.value = "";
      await fn(v);
    }
  });
}

function closeModal() {
  state.modalId = null;
  state.dirty = false;
  state.attach = null; // stop routing drops/pastes to a closed ticket
  el("modal").classList.add("hidden");
}

// ---- sprint manager --------------------------------------------------------
function ticketsInSprint(id) {
  return state.board.tickets.filter((t) => t.sprint === id);
}

function openSprintModal() {
  const sprints = state.board.sprints;
  const body = el("sprintModalBody");

  const rows = sprints
    .map((s) => {
      const inSprint = ticketsInSprint(s.id);
      const open = inSprint.filter((t) => t.status !== "done").length;
      return `
      <div class="sprint-row ${s.status === "closed" ? "closed" : ""}" data-id="${escapeAttr(s.id)}">
        <div class="sr-head">
          <span class="sr-name">${escapeHtml(s.name)}</span>
          <span class="sr-badge ${s.status === "active" ? "active" : ""}">${escapeHtml(s.status)}</span>
          <span class="sr-badge count">${inSprint.length} tickets · ${open} open</span>
        </div>
        <div class="sr-grid">
          <div class="field"><label>Name</label><input class="sr-name-in" value="${escapeAttr(s.name)}" /></div>
          <div class="field"><label>Status</label>
            <select class="sr-status-in">
              ${["active", "closed"].map((v) => opt(v, v, s.status)).join("")}
            </select></div>
          <div class="field"><label>Start</label><input class="sr-start-in" type="date" value="${s.startDate ? String(s.startDate).slice(0, 10) : ""}" /></div>
          <div class="field"><label>End</label><input class="sr-end-in" type="date" value="${s.endDate ? String(s.endDate).slice(0, 10) : ""}" /></div>
        </div>
        <div class="field"><label>Goal</label><input class="sr-goal-in" value="${escapeAttr(s.goal || "")}" /></div>
        <div class="sr-actions">
          <button class="btn sm primary sr-save">Save</button>
          <button class="btn sm danger sr-del">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  body.innerHTML = `
    <h2>Sprints — ${escapeHtml(state.board.project.name)}</h2>
    <div class="muted" style="margin-bottom:8px">Deleting a sprint unassigns its tickets (they aren't deleted).</div>
    ${rows || '<div class="muted">No sprints yet.</div>'}
    <div class="sprint-new">
      <div class="field"><label>New sprint name</label><input id="sp_new_name" placeholder="e.g. Sprint 4" /></div>
      <div class="row">
        <div class="field"><label>Start</label><input id="sp_new_start" type="date" /></div>
        <div class="field"><label>End</label><input id="sp_new_end" type="date" /></div>
      </div>
      <div class="field"><label>Goal</label><input id="sp_new_goal" placeholder="optional" /></div>
      <button class="btn primary" id="sp_new_btn">+ Create sprint</button>
    </div>`;

  el("sprintModal").classList.remove("hidden");

  body.querySelectorAll("input, select").forEach((n) => n.addEventListener("focus", () => (state.dirty = true)));

  body.querySelectorAll(".sprint-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".sr-save").addEventListener("click", async () => {
      try {
        await api("PATCH", `/api/projects/${state.project}/sprints/${id}`, {
          name: row.querySelector(".sr-name-in").value.trim(),
          status: row.querySelector(".sr-status-in").value,
          startDate: row.querySelector(".sr-start-in").value || null,
          endDate: row.querySelector(".sr-end-in").value || null,
          goal: row.querySelector(".sr-goal-in").value.trim(),
        });
        state.dirty = false;
        await refresh();
        openSprintModal();
        toast(`Saved ${id}`, "", "success");
      } catch (e) {
        toast("Save failed", e.message, "error");
      }
    });
    row.querySelector(".sr-del").addEventListener("click", async () => {
      const n = ticketsInSprint(id).length;
      if (!confirm(`Delete sprint "${id}"?${n ? ` ${n} ticket(s) will be unassigned.` : ""}`)) return;
      try {
        const r = await api("DELETE", `/api/projects/${state.project}/sprints/${id}`);
        state.dirty = false;
        await refresh();
        openSprintModal();
        toast(`Deleted ${id}`, r.unassigned ? `${r.unassigned} ticket(s) unassigned` : "", "success");
      } catch (e) {
        toast("Delete failed", e.message, "error");
      }
    });
  });

  el("sp_new_btn").addEventListener("click", async () => {
    const name = el("sp_new_name").value.trim();
    if (!name) return toast("Name required", "", "error");
    try {
      const s = await api("POST", `/api/projects/${state.project}/sprints`, {
        name,
        startDate: el("sp_new_start").value || null,
        endDate: el("sp_new_end").value || null,
        goal: el("sp_new_goal").value.trim(),
      });
      state.dirty = false;
      await refresh();
      openSprintModal();
      toast(`Created ${s.id}`, name, "success");
    } catch (e) {
      toast("Create failed", e.message, "error");
    }
  });
}

function closeSprintModal() {
  state.dirty = false;
  el("sprintModal").classList.add("hidden");
}

function renderNote(n) {
  return `<div class="note"><div class="ts">${escapeHtml(n.ts)}</div>${escapeHtml(n.text)}</div>`;
}

// Body convention: "### <iso-timestamp>\n<text>" blocks (see store.appendNote).
// Any leading text before the first ### is shown as a description note.
function parseNotes(body) {
  if (!body || !body.trim()) return [];
  const parts = body.split(/^### /m);
  const notes = [];
  const lead = parts.shift();
  if (lead && lead.trim()) notes.push({ ts: "description", text: lead.trim() });
  for (const p of parts) {
    const nl = p.indexOf("\n");
    if (nl === -1) {
      notes.push({ ts: p.trim(), text: "" });
    } else {
      notes.push({ ts: p.slice(0, nl).trim(), text: p.slice(nl + 1).trim() });
    }
  }
  return notes.reverse(); // newest first
}

// ---- create flows ----------------------------------------------------------
function bindTopbar() {
  el("projectSelect").addEventListener("change", (e) => {
    state.project = e.target.value;
    localStorage.setItem("clambake.project", state.project);
    state.sprintFilter = "";
    refresh();
  });
  el("sprintFilter").addEventListener("change", (e) => {
    state.sprintFilter = e.target.value;
    render();
  });
  el("epicFilter").addEventListener("change", (e) => {
    state.epicFilter = e.target.value;
    render();
  });
  el("behindOnly").addEventListener("change", (e) => {
    state.behindOnly = e.target.checked;
    render();
  });
  el("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  el("modalClose").addEventListener("click", closeModal);
  el("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  el("sprintModalClose").addEventListener("click", closeSprintModal);
  el("sprintModal").addEventListener("click", (e) => {
    if (e.target.id === "sprintModal") closeSprintModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!el("sprintModal").classList.contains("hidden")) closeSprintModal();
      else if (state.modalId) closeModal();
    }
  });

  // Attachment drag-drop + paste: bound ONCE here, routed to the open ticket via
  // state.attach (set by openModal). Bound once = no listener stacking / dup uploads.
  window.addEventListener("dragover", (e) => {
    if (!state.attach) return;
    e.preventDefault();
    el("m_drop")?.classList.add("drag");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) el("m_drop")?.classList.remove("drag");
  });
  window.addEventListener("drop", (e) => {
    if (!state.attach) return;
    e.preventDefault();
    el("m_drop")?.classList.remove("drag");
    if (e.dataTransfer?.files?.length) state.attach.upload(e.dataTransfer.files);
  });
  document.addEventListener("paste", (e) => {
    if (!state.attach) return;
    const imgs = [];
    for (const it of e.clipboardData?.items || []) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      state.attach.upload(imgs);
    }
  });

  el("newTicketBtn").addEventListener("click", async () => {
    if (!state.project) return alert("Create a project first.");
    const title = prompt("Ticket title:");
    if (!title) return;
    const t = await api("POST", `/api/projects/${state.project}/tickets`, { title, status: "backlog" });
    await refresh();
    state.modalId = t.id;
    render();
  });

  el("sprintsBtn").addEventListener("click", () => {
    if (!state.project) return alert("Create a project first.");
    openSprintModal();
  });

  el("newProjectBtn").addEventListener("click", async () => {
    const slug = prompt("Project slug (a-z0-9-_):");
    if (!slug) return;
    const name = prompt("Display name:") || slug;
    const idPrefix = prompt("Ticket id prefix (e.g. MET):") || undefined;
    try {
      await api("POST", "/api/projects", { slug, name, idPrefix });
      state.project = slug;
      localStorage.setItem("clambake.project", slug);
      await loadProjects();
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  });
}

// ---- utils -----------------------------------------------------------------
function opt(value, label, selected) {
  return `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
// Render markdown (with raw-HTML passthrough) via the vendored marked. Authors are
// trusted (PM/coders/you on the LAN); falls back to escaped text if marked is absent.
function renderMd(s) {
  try {
    return window.marked ? window.marked.parse(String(s)) : escapeHtml(String(s)).replace(/\n/g, "<br>");
  } catch {
    return escapeHtml(String(s));
  }
}

// Transient bottom-right feedback. type: "success" | "error" | "info".
function toast(title, sub = "", type = "success") {
  const wrap = el("toasts");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${
    sub ? `<div class="t-sub">${escapeHtml(sub)}</div>` : ""
  }`;
  wrap.appendChild(node);
  const ttl = type === "error" ? 5000 : 2600;
  setTimeout(() => {
    node.classList.add("out");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, ttl);
}

init();
