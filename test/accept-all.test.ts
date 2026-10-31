import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-many-"));
}

function wsWith(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-many-ws-"));
  fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("accepting every change across projects keeps all of them", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const wsA = wsWith("a.txt", "one\n");
  const wsB = wsWith("b.txt", "alpha\n");
  await store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(wsA, "a.txt", "one changed\n");
  store.propose(wsB, "b.txt", "alpha changed\n");

  // Simulate "Accept All" across both projects.
  for (const ws of [wsA, wsB]) {
    for (const s of store.listChanges(ws)) {
      store.accept(s.id);
    }
  }

  assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one changed\n");
  assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha changed\n");
  assert.equal(store.listChanges(wsA).length, 0);
  assert.equal(store.listChanges(wsB).length, 0);
});

test("rejecting every change across projects restores all baselines", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const wsA = wsWith("a.txt", "one\n");
  const wsB = wsWith("b.txt", "alpha\n");
  await store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(wsA, "a.txt", "one changed\n");
  store.propose(wsB, "b.txt", "alpha changed\n");

  for (const ws of [wsA, wsB]) {
    for (const s of store.listChanges(ws)) {
      store.reject(s.id);
    }
  }

  assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one\n");
  assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\n");
});

test("per-project accept leaves the other project untouched", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const wsA = wsWith("a.txt", "one\n");
  const wsB = wsWith("b.txt", "alpha\n");
  await store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(wsA, "a.txt", "one changed\n");
  store.propose(wsB, "b.txt", "alpha changed\n");

  // Accept only project A.
  for (const s of store.listChanges(wsA)) {
    store.accept(s.id);
  }

  assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one changed\n");
  assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\n", "B was never accepted, so it stays at its baseline");
  assert.equal(store.listChanges(wsB).length, 1, "B is still pending review");
});

test("accepting multiple changes in one project resolves all of them", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-multi-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
  fs.writeFileSync(path.join(ws, "b.txt"), "two\n");
  fs.writeFileSync(path.join(ws, "c.txt"), "three\n");
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(ws, "a.txt", "one changed\n");
  store.propose(ws, "b.txt", "two changed\n");
  store.propose(ws, "c.txt", "three changed\n");

  assert.equal(store.listChanges(ws).length, 3);
  for (const s of store.listChanges(ws)) {
    store.accept(s.id);
  }
  assert.equal(store.listChanges(ws).length, 0);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one changed\n");
  assert.equal(fs.readFileSync(path.join(ws, "b.txt"), "utf8"), "two changed\n");
  assert.equal(fs.readFileSync(path.join(ws, "c.txt"), "utf8"), "three changed\n");
});

test("independent per-block decisions: accept A, leave B pending, reject C", async () => {
  // The exact scenario from the requirement. Three well-separated edits in one file must
  // be decided independently — no decision may touch another block.
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-abc-"));
  const file = path.join(ws, "x.py");
  const pad = "pad\n".repeat(15);
  const OLD = `A = 1\n${pad}B = 2\n${pad}C = 3\n`;
  const NEW = `A = 111\n${pad}B = 222\n${pad}C = 333\n`;
  fs.writeFileSync(file, OLD);
  const cs = store.propose(ws, "x.py", NEW);
  assert.equal(cs.hunks.length, 3, "three separate blocks");

  // A -> accept, C -> reject, B -> untouched.
  store.accept(cs.id, [cs.hunks[0].id]);
  store.reject(cs.id, [cs.hunks[2].id]);

  const after = store.findById(cs.id)!;
  assert.deepEqual(
    after.hunks.map((h) => h.decision),
    ["accepted", "pending", "rejected"],
    "each block keeps its own decision",
  );

  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 111"), "A is the accepted (new) value");
  assert.ok(text.includes("B = 2\n"), "B is untouched — pending hunks are not written");
  assert.equal(text.includes("B = 222"), false, "B's new value is not on disk until accepted");
  assert.ok(text.includes("C = 3\n"), "C is reverted to the baseline value");
  assert.equal(text.includes("C = 333"), false, "C's new value is gone");

  // B is still awaiting review, so the change set survives.
  assert.equal(store.listChanges(ws).length, 1, "the file still needs review for B");
});
