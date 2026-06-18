// Tests for auto-archive: doneAt stamping, eligibility, and the move/restore
// store operations. Like store.test.js, point CLAMBAKE_DATA at a temp dir before
// importing the store.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clambake-arch-"));
process.env.CLAMBAKE_DATA = DATA_DIR;

const store = await import("../lib/store.js");
const { shouldArchive, doneAgeDays } = await import("../lib/schema.js");

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

let n = 0;
function freshProject(archiveDoneAfterDays) {
  const slug = `proj${n++}`;
  store.createProject({ slug, idPrefix: "T", archiveDoneAfterDays });
  return slug;
}
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000);

test("createProject persists archiveDoneAfterDays", () => {
  const slug = freshProject(2);
  assert.equal(store.getProject(slug).archiveDoneAfterDays, 2);
  // Omitting it defaults to null (off).
  const off = freshProject(undefined);
  assert.equal(store.getProject(off).archiveDoneAfterDays, null);
});

test("doneAt is stamped on entering done and cleared on leaving", () => {
  const slug = freshProject(2);
  const t = store.createTicket(slug, { title: "x" });
  assert.equal(t.doneAt, null);
  assert.ok(store.updateTicket(slug, t.id, { status: "done" }).doneAt);
  assert.equal(store.updateTicket(slug, t.id, { status: "active" }).doneAt, null);
  // Created directly in done is stamped too.
  const born = store.createTicket(slug, { title: "born done", status: "done" });
  assert.ok(born.doneAt);
});

test("shouldArchive / doneAgeDays key off doneAt with updatedAt fallback", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");
  const done = { status: "done", doneAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" };
  assert.equal(Math.round(doneAgeDays(done, now)), 9); // from doneAt, not updatedAt
  assert.equal(shouldArchive(done, 2, now), true);
  assert.equal(shouldArchive(done, 30, now), false);
  // Non-done is never eligible; null threshold disables.
  assert.equal(shouldArchive({ status: "active", updatedAt: done.doneAt }, 2, now), false);
  assert.equal(shouldArchive(done, null, now), false);
  // Legacy ticket with no doneAt falls back to updatedAt.
  const legacy = { status: "done", doneAt: null, updatedAt: "2026-06-01T00:00:00.000Z" };
  assert.equal(Math.round(doneAgeDays(legacy, now)), 9);
});

test("sweepArchive moves eligible done tickets off the board and back", () => {
  const slug = freshProject(2);
  const a = store.createTicket(slug, { title: "done", status: "done" });
  const b = store.createTicket(slug, { title: "active" });

  // Nothing is old enough yet.
  assert.deepEqual(store.sweepArchive(slug, { dryRun: true }).eligible, []);

  // Three days on, the done ticket is eligible; dry-run reports without moving.
  const future = daysFromNow(3);
  assert.deepEqual(store.sweepArchive(slug, { now: future, dryRun: true }).eligible, [a.id]);
  assert.equal(store.getBoard(slug).tickets.length, 2);

  // Real sweep moves it out of the board into the archive.
  assert.deepEqual(store.sweepArchive(slug, { now: future }).archived, [a.id]);
  assert.deepEqual(
    store.getBoard(slug).tickets.map((t) => t.id),
    [b.id]
  );
  assert.deepEqual(
    store.listArchived(slug).map((t) => t.id),
    [a.id]
  );

  // Unarchive restores it.
  store.unarchiveTicket(slug, a.id);
  assert.equal(store.listArchived(slug).length, 0);
  assert.ok(store.getBoard(slug).tickets.some((t) => t.id === a.id));
});

test("sweepArchive is a no-op when archiving is disabled, honours days override", () => {
  const slug = freshProject(undefined); // archiving off
  store.createTicket(slug, { title: "done", status: "done" });
  // Disabled + no override: nothing moves even far in the future.
  assert.deepEqual(store.sweepArchive(slug, { now: daysFromNow(99) }).archived, []);
  // Explicit days override forces eligibility immediately.
  assert.equal(store.sweepArchive(slug, { days: 0, dryRun: true }).eligible.length, 1);
});

test("archiveTicket / unarchiveTicket guard missing and duplicate ids", () => {
  const slug = freshProject(2);
  assert.throws(() => store.archiveTicket(slug, "T-999"), /No such ticket/);
  const t = store.createTicket(slug, { title: "x", status: "done" });
  store.archiveTicket(slug, t.id);
  assert.throws(() => store.unarchiveTicket(slug, "T-999"), /No such archived/);
  // A live ticket with the same id blocks restore.
  store.createTicket(slug, { id: t.id, title: "dup" });
  assert.throws(() => store.unarchiveTicket(slug, t.id), /already exists/);
});
