import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `vscode` is aliased to the stub by the runner.
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ChangeFileDecorationProvider } from "../vscode/src/ui/editor/file-decorations";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-fdec-"));
}

function providerFor(store: ChangeStore, ws: string): ChangeFileDecorationProvider {
  return new ChangeFileDecorationProvider(store, () => [ws]);
}

test("a changed file gets a badge with pending count", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "a.ts"), "one\ntwo\n");
  const cs = store.propose(ws, "a.ts", "one\nTWO\n");
  const provider = providerFor(store, ws);

  const dec = provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "a.ts")));
  assert.ok(dec, "the changed file is decorated");
  assert.equal(dec!.badge, "M", "a modification reads as M");
  assert.match(String(dec!.tooltip), /1 hunk pending/);
  assert.equal(dec!.propagate, true, "the containing folder shows a dot too");
  assert.equal(cs.hunks.length, 1);
});

test("an unchanged file has no decoration", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "a.ts"), "one\n");
  fs.writeFileSync(path.join(ws, "b.ts"), "other\n");
  store.propose(ws, "a.ts", "changed\n");
  const provider = providerFor(store, ws);

  assert.equal(provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "b.ts"))), undefined);
});

test("a fully decided file loses its badge", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "a.ts"), "one\ntwo\n");
  const cs = store.propose(ws, "a.ts", "one\nTWO\n");
  const provider = providerFor(store, ws);

  assert.ok(provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "a.ts"))), "badged while pending");
  store.accept(cs.id);
  assert.equal(
    provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "a.ts"))),
    undefined,
    "no badge once every hunk is decided",
  );
});

test("a partially decided file keeps its badge, with the remaining count", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "x.py"), "A = 1\n" + "pad\n".repeat(15) + "B = 2\n");
  const cs = store.propose(ws, "x.py", "A = 111\n" + "pad\n".repeat(15) + "B = 222\n");
  assert.equal(cs.hunks.length, 2);
  const provider = providerFor(store, ws);

  store.accept(cs.id, [cs.hunks[0].id]);
  const dec = provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "x.py")));
  assert.ok(dec, "still badged: one hunk remains");
  assert.match(String(dec!.tooltip), /1 hunk pending/);
});

test("a brand-new file reads as A and a deletion as D", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "old.ts"), "bye\n");
  store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(ws, "new.ts", "hello\n");
  store.propose(ws, "old.ts", "", { delete: true });

  const provider = providerFor(store, ws);
  assert.equal(provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "new.ts")))?.badge, "A");
  assert.equal(provider.provideFileDecoration(vscode.Uri.file(path.join(ws, "old.ts")))?.badge, "D");
});

test("a non-file URI is never decorated", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "a.ts"), "one\n");
  store.propose(ws, "a.ts", "changed\n");
  const provider = providerFor(store, ws);

  assert.equal(provider.provideFileDecoration(vscode.Uri.parse("review-hub://baseline/abc")), undefined);
});
