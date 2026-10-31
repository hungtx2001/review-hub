import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";
import { flushPendingReviews } from "../core/src/exit-flush";

const OLD = "a\nb\nc\nd\n";
const NEW = "A\nb\nC\nd\n";

function fixture(): { ws: string; file: string; store: ChangeStore } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-flush-"));
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-flush-home-")) });
  return { ws, file, store };
}

test("a staged (mcp) change the user never touched lands as the agent's new code", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "propose() writes nothing — review-then-apply");

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 1);
  assert.equal(fs.readFileSync(file, "utf8"), NEW, "exit means: undecided = accepted (spec D6)");
  assert.equal(store.listChangeSets(ws).length, 0, "the cache is pruned");
});

test("a direct write (fs) change keeps the agent's bytes and is marked resolved", async () => {
  const { ws, file, store } = fixture();
  fs.writeFileSync(file, NEW);
  const observed = await store.observe(ws, "a.txt");
  assert.ok(observed, "the direct write is observed");
  assert.equal(observed!.origin, "fs");
  assert.equal(observed!.status, "pending");

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 1);
  assert.equal(fs.readFileSync(file, "utf8"), NEW, "the file is untouched: the agent already wrote it");
  assert.equal(store.listChangeSets(ws).length, 0, "the record is resolved and pruned");
});

test("a hunk the user rejected survives the flush", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  assert.equal(cs.hunks.length, 2, "two independent hunks");
  store.reject(cs.id, [cs.hunks[0].id]); // keep the baseline for hunk 1 only

  flushPendingReviews(store, [ws]);

  assert.equal(
    fs.readFileSync(file, "utf8"),
    "a\nb\nC\nd\n",
    "hunk 1 stays at the baseline, hunk 2 becomes the agent's new code",
  );
});

test("a window with nothing pending accepts nothing", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  store.accept(cs.id); // already decided before the window closed

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 0);
  assert.equal(fs.readFileSync(file, "utf8"), NEW);
});
