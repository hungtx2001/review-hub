import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-fallback-"));
}

/** A file that is not a SQLite database: the driver opens it, then the schema exec fails. */
function corruptHubDb(baseDir: string): void {
  fs.writeFileSync(path.join(baseDir, "hub.db"), "this is definitely not a database");
}

test("auto backend falls back to JSON when hub.db is corrupt", async () => {
  const baseDir = tmp();
  corruptHubDb(baseDir);

  const store = new ChangeStore({ baseDir, backend: "auto" });

  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
  const cs = store.propose(ws, "a.txt", "one\nTWO\n");
  store.accept(cs.id);

  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\n", "the JSON fallback still applies decisions");
  assert.equal(store.listChanges(ws).length, 0, "the change resolved through the fallback backend");
  store.dispose();
});

test("explicit sqlite backend still throws on a corrupt hub.db", () => {
  const baseDir = tmp();
  corruptHubDb(baseDir);
  assert.throws(() => new ChangeStore({ baseDir, backend: "sqlite" }));
});

test("explicit json backend does not throw on a corrupt hub.db", () => {
  const baseDir = tmp();
  corruptHubDb(baseDir);
  const store = new ChangeStore({ baseDir, backend: "json" });
  assert.ok(store);
  store.dispose();
});
