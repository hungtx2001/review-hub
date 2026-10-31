import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";
import { computeHunks, resolveHunkRanges, splitContent, joinContent } from "../core/src/hunk-diff";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
}

const pad = "pad\n".repeat(15);
const OLD = `A = 1\n${pad}B = 2\n${pad}C = 3\n`;
const NEW = `A = 111\n${pad}B = 222\n${pad}C = 333\n`;

// ---- Reject must not resurrect the file as a change ------------------------------

test("reject-all of a modified file leaves no change on re-observe", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  store.reject(cs.id);

  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(await store.observe(ws, "a.txt"), undefined, "the rejected file must not reappear");
  assert.equal(store.listChanges(ws).length, 0);
});

test("rejecting an agent delete restores the file and does not re-report it", async () => {
  const ws = tmp();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "one\ntwo\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(ws, "a.txt", "", { delete: true });
  const cs = store.findChangeByPath(ws, "a.txt")!;
  store.reject(cs.id);

  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n", "delete reverted");
  assert.equal(await store.observe(ws, "a.txt"), undefined, "restored file must not reappear");
});

test("accepting an agent delete keeps it deleted and does not re-report it", async () => {
  const ws = tmp();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "one\ntwo\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(ws, "a.txt", "", { delete: true });
  const cs = store.findChangeByPath(ws, "a.txt")!;
  store.accept(cs.id);

  assert.equal(fs.existsSync(file), false, "accepted delete stays deleted");
  assert.equal(await store.observe(ws, "a.txt"), undefined, "deleted file must not reappear");
});

// ---- Framing: reject restores the baseline's exact bytes -------------------------

test("reject restores a file that had no trailing newline", async () => {
  const ws = tmp();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "one\ntwo");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\ntwo\n");
  store.reject(cs.id);
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo", "the missing trailing newline is restored");
});

test("reject restores a file whose whole content was replaced by nothing", async () => {
  const ws = tmp();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "hello\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "");
  store.reject(cs.id);
  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
});

test("reject restores CRLF framing", async () => {
  const ws = tmp();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "a\r\nb\r\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "a\r\nB\r\n");
  store.reject(cs.id);
  assert.equal(fs.readFileSync(file, "utf8"), "a\r\nb\r\n");
});

test("a file that is a single newline round-trips", () => {
  const info = splitContent("\n");
  assert.deepEqual(info.lines, [""], "one blank line, not an empty file");
  assert.equal(joinContent(info.lines, info), "\n");
});

// ---- Line mapping for the real file ----------------------------------------------

test("resolveHunkRanges tracks hunks after a rejected hunk shifts the lines below", () => {
  const shortPad = "ctx\n".repeat(5);
  const baseline = splitContent(`A\n${shortPad}B\n`).lines;
  const proposed = splitContent(`A1\nA2\nA3\nA4\n${shortPad}B1\n`).lines;
  const hunks = computeHunks(baseline, proposed);
  assert.equal(hunks.length, 2, "two separated hunks");

  // Accept the first (1 line -> 4 lines), leaving the second pending.
  const decided = hunks.map((h, i) => (i === 0 ? { ...h, decision: "accepted" as const } : h));
  let ranges = resolveHunkRanges(baseline, decided);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[0].length, 4);
  assert.equal(ranges[1].start, 9, "second hunk follows the 4 added lines");

  // Now reject the first: the disk shrinks by 3 lines, so the second hunk moves up.
  const rejected = decided.map((h) => (h.id === decided[0].id ? { ...h, decision: "rejected" as const } : h));
  ranges = resolveHunkRanges(baseline, rejected);
  assert.equal(ranges[0].length, 1, "rejected hunk contributes its single baseline line");
  assert.equal(ranges[1].start, 6, "the second hunk shifts up by the three lines the first no longer adds");
  assert.notEqual(ranges[1].start, hunks[1].newStart, "the proposed frame would have been wrong");
});

// ---- Independent decisions -------------------------------------------------------

test("accept B writes only B; A and C stay at their baseline lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  const r = store.accept(cs.id, [cs.hunks[1].id]);
  assert.equal(r.resolved, false);
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "accepted", "pending"]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("B = 222"), "B is on disk");
  assert.equal(text.includes("A = 111"), false, "A is only pending, so it is not on disk");
  assert.equal(text.includes("C = 333"), false, "C is only pending, so it is not on disk");
});

test("reject B writes nothing; A and C stay at their baseline lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.reject(cs.id, [cs.hunks[1].id]);
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "rejected", "pending"]);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "the file is still exactly the baseline");
  assert.equal(store.listChanges(ws).length, 1, "still pending for A and C");
});

// ---- Framing: a partial accept keeps the baseline's line endings ------------------

test("partial accept keeps CRLF on the untouched lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "crlf.txt");
  const baseline = "a\r\nb\r\nc\r\nd\r\n";
  fs.writeFileSync(file, baseline);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  const cs = store.propose(ws, "crlf.txt", "A\nb\nC\nd\n");
  assert.equal(cs.hunks.length, 2, "two separated hunks");

  store.accept(cs.id, [cs.hunks[0].id]);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "A\r\nb\r\nc\r\nd\r\n",
    "the accepted line and every untouched line keep CRLF",
  );

  // Accepting the rest lands the whole proposal, framing included.
  store.accept(cs.id);
  assert.equal(fs.readFileSync(file, "utf8"), "A\nb\nC\nd\n", "a full accept uses the proposal's framing");
});
