import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-rta-"));
}

const PAD = "pad\n".repeat(15);
const OLD = `A = 1\n${PAD}B = 2\n${PAD}C = 3\n`;
const NEW = `A = 111\n${PAD}B = 222\n${PAD}C = 333\n`;

test("propose leaves the file on disk untouched", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  const cs = store.propose(ws, "x.py", NEW);
  assert.equal(cs.hunks.length, 3, "three separate blocks");
  assert.equal(cs.applied, false, "a staged proposal is not on disk");
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "propose must not write the file");
  assert.equal(store.listChanges(ws).length, 1, "it is still listed for review");
});

test("accepting one hunk writes only that hunk's lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.accept(cs.id, [cs.hunks[1].id]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 1\n"), "A is still the baseline value — it is only pending");
  assert.ok(text.includes("B = 222"), "B is the accepted value, now on disk");
  assert.ok(text.includes("C = 3\n"), "C is still the baseline value — it is only pending");
  assert.equal(text.includes("A = 111"), false, "A's new value is NOT on disk");
  assert.equal(text.includes("C = 333"), false, "C's new value is NOT on disk");
});

test("rejecting a hunk leaves its baseline lines in place", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.reject(cs.id, [cs.hunks[2].id]);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "nothing was written for a rejection");
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "pending", "rejected"]);
});

test("accepting every hunk materialises the whole proposal", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  const result = store.accept(cs.id);
  assert.equal(result.resolved, true);
  assert.equal(fs.readFileSync(file, "utf8"), NEW);
});

test("re-observing a file our own decisions wrote keeps the staged change", async () => {
  // The watcher polls every 3 s. After accepting hunk B the file differs from the
  // baseline, so a naive re-observe would recompute hunks from disk and drop the hunks
  // that are still pending (they are not on disk). The staged set must win.
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);
  store.accept(cs.id, [cs.hunks[1].id]);

  const again = await store.observe(ws, "x.py");
  assert.ok(again, "the change is still there");
  assert.equal(again!.hunks.length, 3, "no pending hunk was dropped");
  assert.deepEqual(again!.hunks.map((h) => h.decision), ["pending", "accepted", "pending"]);
});

test("an fs change keeps pending hunks on disk (the agent already wrote them)", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  fs.writeFileSync(file, NEW);
  const cs = await store.observe(ws, "x.py");
  assert.ok(cs);
  assert.equal(cs!.applied, true);
  store.accept(cs!.id, [cs!.hunks[1].id]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 111") && text.includes("B = 222") && text.includes("C = 333"));
});
