import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { HunkCodeLensProvider } from "../vscode/src/ui/editor/diff-view";
import { buildStagedText } from "../vscode/src/ui/editor/staged-content";

function storeFor(OLD: string, NEW: string): { ws: string; store: ChangeStore; changeId: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-lens-"));
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-lens-home-")) });
  fs.writeFileSync(path.join(ws, "a.txt"), OLD);
  const cs = store.propose(ws, "a.txt", NEW);
  return { ws, store, changeId: cs.id };
}

const doc = (fsPath: string, lineCount: number): never =>
  ({ uri: { scheme: "file", fsPath }, lineCount }) as never;

test("a staged file's lenses sit on the merged-view lines and show a diff stat", () => {
  const { ws, store, changeId } = storeFor("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  const stagedText = buildStagedText(store.findById(changeId)!)!;
  const provider = new HunkCodeLensProvider(store, () => true);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), stagedText.split("\n").length));

  assert.equal(lenses.length, 3, "Accept, Reject and the count lens");
  assert.equal(lenses[0].range.startLine, 1, "merged line 1 is the red block");
  assert.equal(lenses[0].command?.title, "$(check) Accept");
  assert.equal(lenses[0].command?.arguments?.[0], changeId);
  assert.equal(lenses[1].command?.title, "$(chrome-close) Reject");
  assert.equal(lenses[2].command?.title, "−1 line, +1 line");
  const tooltip = lenses[2].command?.tooltip;
  assert.match(String(tooltip ?? ""), /two/, "the count lens carries the old code");
});

test("a decided hunk keeps its badge at the merged line", () => {
  const { ws, store, changeId } = storeFor("a\nb\nc\nd\n", "A\nb\nC\nd\n");
  const cs = store.findById(changeId)!;
  store.accept(changeId, [cs.hunks[0].id]); // one hunk decided, one still pending
  const stagedText = buildStagedText(store.findById(changeId)!)!;
  const provider = new HunkCodeLensProvider(store, () => true);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), stagedText.split("\n").length));

  assert.equal(lenses.length, 6, "3 lenses for the accepted hunk + 3 for the pending one");
  assert.equal(lenses[0].range.startLine, 0, "the accepted block starts the merged view");
  assert.equal(lenses[0].command?.title, "$(check) Accepted");
  assert.equal(lenses[3].range.startLine, 2, "the second hunk's red block is on merged line 2");
  assert.equal(lenses[3].command?.title, "$(check) Accept");
});

test("an unstaged file keeps the disk-frame anchors and the plain pending label", () => {
  const { ws, store, changeId } = storeFor("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  const provider = new HunkCodeLensProvider(store, () => false);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), 4));

  assert.equal(lenses.length, 3);
  assert.equal(lenses[0].range.startLine, 1, "baseline frame: the hunk starts on baseline line 1");
  assert.equal(lenses[2].command?.title, "hunk 1/1 · pending", "no diff stat outside staging");
});
