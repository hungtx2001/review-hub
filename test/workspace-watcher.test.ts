import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The watcher imports `vscode`, aliased to the stub by the test runner.
import { WorkspaceWatcher } from "../vscode/src/watcher/workspace-watcher";
import { ChangeStore } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-watch-"));
}

/** Build a watcher and expose its private scan, so we can drive it without timers. */
function makeWatcher(store: ChangeStore, workspaces: string[], excludeGlobs: string[]) {
  const changes: { ws: string; rel: string }[] = [];
  const watcher = new WorkspaceWatcher(
    store,
    () => workspaces,
    excludeGlobs,
    (ws, rel) => changes.push({ ws, rel }),
  );
  return { watcher, changes };
}

test("a non-git scan never reads excluded directories", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;\n");
  fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "module.exports = 2;\n");
  fs.mkdirSync(path.join(ws, "dist"));
  fs.writeFileSync(path.join(ws, "dist", "bundle.js"), "x\n");

  const store = new ChangeStore({ baseDir: tmp(), excludeGlobs: ["**/node_modules/**", "**/dist/**"] });
  const { watcher } = makeWatcher(store, [ws], ["**/node_modules/**", "**/dist/**"]);

  // Count which directories the scan actually opens. The point of pruning before
  // descending is that the excluded directories are never opened at all — with the old
  // `**/dir/**` translation the bare directory did not match, so the walker opened it
  // and only filtered its children afterwards.
  const realReaddir = fs.promises.readdir;
  const opened: string[] = [];
  (fs.promises as { readdir: unknown }).readdir = (dir: string, opts?: unknown) => {
    opened.push(path.basename(dir));
    return (realReaddir as (d: string, o?: unknown) => Promise<unknown>)(dir, opts);
  };
  try {
    await (watcher as unknown as { scanWorkspace(w: string): Promise<void> }).scanWorkspace(ws);
  } finally {
    (fs.promises as { readdir: unknown }).readdir = realReaddir;
    watcher.dispose();
  }

  assert.equal(opened.filter((d) => d === "node_modules").length, 0, "node_modules is never opened");
  assert.equal(opened.filter((d) => d === "dist").length, 0, "dist is never opened");
  assert.deepEqual(opened, [path.basename(ws)], "only the workspace root is read");

  const info = store.checkpointInfo(ws);
  assert.ok(info, "the scan seeded a checkpoint");
  assert.equal(info!.files, 1, "only the source file is baselined");
});

test("a non-git scan reports a change to a previously-seen file", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;\n");
  const store = new ChangeStore({ baseDir: tmp() });
  const { watcher, changes } = makeWatcher(store, [ws], []);
  const scan = (w: string) => (watcher as unknown as { scanWorkspace(w: string): Promise<void> }).scanWorkspace(w);

  // First scan: adopt the current state as the baseline, report nothing.
  await scan(ws);
  assert.equal(changes.length, 0, "the first scan only seeds baselines");

  // Second scan after an edit: the change is reported.
  fs.writeFileSync(path.join(ws, "a.ts"), "const a = 2;\n");
  await scan(ws);
  watcher.dispose();

  assert.equal(changes.length, 1, "the edit is reported");
  assert.equal(changes[0].rel, "a.ts");
  const cs = store.findChangeByPath(ws, "a.ts");
  assert.ok(cs, "a change set was recorded");
  assert.equal(cs!.baseline, "const a = 1;\n");
});

test("dispose stops the poll timer and watcher", () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.ts"), "x\n");
  const store = new ChangeStore({ baseDir: tmp() });
  const { watcher } = makeWatcher(store, [ws], []);
  watcher.start();
  assert.doesNotThrow(() => watcher.dispose());
});
