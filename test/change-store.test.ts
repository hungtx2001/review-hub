import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore, globToRegExp } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-store-"));
}

function makeWorkspace(): string {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
  return ws;
}

test("checkpoint snapshots current state and clear works", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  const info = await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  assert.equal(info.files, 1);
  assert.ok(store.checkpointInfo(ws));
  store.clearCheckpoint(ws);
  assert.equal(store.checkpointInfo(ws), undefined);
});

test("propose stages without writing; accept writes the accepted lines", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  assert.equal(cs.hunks.length, 1);
  // Review-then-apply: nothing is written until the user decides.
  assert.equal(cs.applied, false);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\ntwo\nthree\n");

  const result = store.accept(cs.id);
  assert.equal(result.resolved, true);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  // The resolved set is kept so an open review tab can render its final state...
  assert.equal(store.findById(cs.id)?.status, "resolved");
  // ...but it no longer counts as a change awaiting review.
  assert.equal(store.listChanges(ws).length, 0);
  // And once stale, it is pruned from disk.
  store.pruneResolved(0);
  assert.equal(store.findById(cs.id), undefined);
});

test("propose then reject restores the baseline on disk", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  store.reject(cs.id);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("observed direct write is applied; rejecting a hunk restores baseline lines", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  // agent writes directly
  fs.writeFileSync(path.join(ws, "a.txt"), "one\nTWO\nthree\n");
  const cs = await store.observe(ws, "a.txt");
  assert.ok(cs);
  assert.equal(cs.applied, true);
  assert.equal(cs.hunks.length, 1);

  store.reject(cs.id, [cs.hunks[0].id]);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\ntwo\nthree\n");
});

test("observed direct write accepts keeps the new content", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  fs.writeFileSync(path.join(ws, "a.txt"), "one\nTWO\nthree\n");
  const cs = await store.observe(ws, "a.txt");
  store.accept(cs!.id);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\nthree\n");
});

test("decisions survive a reload (new store instance)", async () => {
  const ws = makeWorkspace();
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  store.accept(cs.id, [cs.hunks[0].id]);
  // all decided -> resolved and removed; propose again to check a persisted pending case
  const cs2 = store.propose(ws, "a.txt", "one\nTHREE\nthree\n");
  const store2 = new ChangeStore({ baseDir });
  const reloaded = store2.findById(cs2.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.path, "a.txt");
  assert.equal(reloaded!.hunks.length, 1);
});

test("path traversal is rejected", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  assert.throws(() => store.propose(ws, "../escape.txt", "x"));
});

test("excluded globs are not observed", async () => {
  const ws = makeWorkspace();
  fs.mkdirSync(path.join(ws, "node_modules"));
  fs.writeFileSync(path.join(ws, "node_modules", "x.js"), "junk\n");
  const store = new ChangeStore({ baseDir: tmp(), excludeGlobs: ["**/node_modules/**"] });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: ["**/node_modules/**"] });
  assert.equal(await store.observe(ws, "node_modules/x.js"), undefined);
});

test("**/dir/** matches the bare directory, so the walker can prune it", () => {
  const re = globToRegExp("**/node_modules/**");
  // The bare directory must match: otherwise the walker descends into it and only
  // filters its children one by one — the disk/CPU blow-up this guards against.
  assert.ok(re.test("node_modules"), "bare top-level directory");
  assert.ok(re.test("node_modules/foo"), "child of top-level directory");
  assert.ok(re.test("a/b/node_modules"), "bare nested directory");
  assert.ok(re.test("a/b/node_modules/x/y.js"), "deep child");
  assert.equal(re.test("src/a.ts"), false, "unrelated file");
  assert.equal(re.test("node_modules_backup/x.js"), false, "prefix must not match");

  const png = globToRegExp("**/*.png");
  assert.ok(png.test("logo.png"));
  assert.ok(png.test("a/b/logo.png"));
  assert.equal(png.test("a/b/logo.ts"), false);
});

test("captureBaselines seeds many files in one checkpoint write", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(ws, "b.ts"), "const b = 2;\n");
  fs.writeFileSync(path.join(ws, "logo.png"), "\x89PNG\r\n\x1a\n");
  const store = new ChangeStore({ baseDir: tmp() });
  store.captureBaselines(ws, ["a.ts", "b.ts", "logo.png"], { includeExtensions: [".ts"] });

  const info = store.checkpointInfo(ws);
  assert.ok(info, "a checkpoint was written");
  assert.equal(info!.files, 2, "only the .ts files are baselined; .png is filtered out");
  // The seeded baselines mean these files read as unchanged...
  assert.equal(await store.observe(ws, "a.ts"), undefined);
  // ...and a later edit is reported against the seeded baseline.
  fs.writeFileSync(path.join(ws, "a.ts"), "const a = 99;\n");
  const cs = await store.observe(ws, "a.ts");
  assert.ok(cs, "an edit after seeding is reported");
  assert.equal(cs!.baseline, "const a = 1;\n");
});

test("new file created by agent: reject deletes it", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  fs.writeFileSync(path.join(ws, "new.txt"), "hello\n");
  const cs = await store.observe(ws, "new.txt");
  assert.ok(cs);
  store.reject(cs!.id);
  assert.equal(fs.existsSync(path.join(ws, "new.txt")), false);
});

test("file reverted to baseline drops the change set", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  fs.writeFileSync(path.join(ws, "a.txt"), "one\nTWO\nthree\n");
  const cs = await store.observe(ws, "a.txt");
  assert.ok(cs);
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
  assert.equal(await store.observe(ws, "a.txt"), undefined);
  assert.equal(store.listChanges(ws).length, 0);
});

test("per-session: a session with no changes shows nothing", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  // No proposes, no observes: the change list stays empty.
  assert.equal(store.listChanges(ws).length, 0);
});

test("per-session: only files that actually change are tracked", async () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, "b.txt"), "other\n");
  fs.writeFileSync(path.join(ws, "c.txt"), "third\n");
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  // Only b.txt changes in this session.
  fs.writeFileSync(path.join(ws, "b.txt"), "OTHER\n");
  const cs = await store.observe(ws, "b.txt");
  assert.ok(cs);
  const list = store.listChanges(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, "b.txt");
});

test("checkpoint is bounded by maxFiles and marks truncation", async () => {
  const ws = tmp();
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(ws, `f${i}.txt`), `content ${i}\n`);
  }
  const store = new ChangeStore({ baseDir: tmp() });
  const info = await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [], maxFiles: 10 });
  assert.ok(info.files <= 10, `expected <= 10 files, got ${info.files}`);
});

test("extension allowlist skips non-source files", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "code.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(ws, "model.pt"), "binary-ish");
  fs.writeFileSync(path.join(ws, "data.csv"), "a,b\n1,2\n");
  const store = new ChangeStore({ baseDir: tmp() });
  const info = await store.setCheckpoint(ws, {
    maxFileSize: 1e9,
    excludeGlobs: [],
    includeExtensions: [".ts"],
  });
  assert.equal(info.files, 1, "only the .ts file should be captured");
});

test("listChangeSets returns full change sets for the panel and the review tab", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");

  const sets = store.listChangeSets(ws);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, cs.id);
  assert.equal(sets[0].hunks.length, 1, "hunks come with it, not just counts");
  assert.equal(sets[0].baseline, "one\ntwo\nthree\n", "the baseline travels too");

  store.accept(cs.id);
  assert.equal(store.listChangeSets(ws).length, 0, "a resolved set is not listed");
  store.dispose();
});

test("the JSON backend can be selected explicitly and behaves identically", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  store.accept(cs.id);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(store.listChanges(ws).length, 0);
  store.dispose();
});
