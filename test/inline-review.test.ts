import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `vscode` is aliased to test/vscode-stub.ts by the runner.
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ChangeContentProvider } from "../vscode/src/ui/editor/content-provider";
import { HunkCodeLensProvider } from "../vscode/src/ui/editor/diff-view";
import { buildReviewState } from "../vscode/src/ui/webview/review-panel-state";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-inline-"));
}

const OLD = "from typing import List, Optional, Sequence, Tuple\nprint('old')\n";
const NEW = "from typing import List, Sequence, Tuple\nprint('new')\n";

test("the content provider exposes `onDidChange`, so VS Code re-queries the merged view", () => {
  // Regression guard: the property must be named `onDidChange` — that is the name VS Code
  // looks for on a TextDocumentContentProvider. Named `onDidChangeTextDocument` (the
  // *workspace* event), the provider still serves content but VS Code never re-queries it,
  // so Accept/Reject appears to do nothing and the merged view keeps the stale text.
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const provider = new ChangeContentProvider(store);
  assert.equal(typeof (provider as { onDidChange?: unknown }).onDidChange, "function", "onDidChange must be exposed");

  // Firing it must reach a listener (i.e. it is a real VS Code Event, not a bare value).
  let fired = 0;
  const sub = (provider.onDidChange as (l: () => void) => { dispose(): void })(() => {
    fired++;
  });
  provider.refresh(cs.id);
  assert.ok(fired > 0, "refresh() must fire onDidChange so the view re-renders");
  sub.dispose();
});

test("the review state shows the OLD lines above the NEW lines", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const state = buildReviewState(cs);
  const oldLine = "from typing import List, Optional, Sequence, Tuple";
  const newLine = "from typing import List, Sequence, Tuple";
  const iOld = state.lines.findIndex((l) => l.text === oldLine && l.kind === "deleted");
  const iNew = state.lines.findIndex((l) => l.text === newLine && l.kind === "added");

  assert.notEqual(iOld, -1, "the old code is present, tagged as deleted (red)");
  assert.notEqual(iNew, -1, "the new code is present, tagged as added (green)");
  assert.ok(iOld < iNew, "the old line is shown directly above the new line");
  assert.ok(state.lines.some((l) => l.text === "print('old')" && l.kind === "deleted"));
  assert.ok(state.lines.some((l) => l.text === "print('new')" && l.kind === "added"));
});

test("rejecting a hunk makes the review state show only the old code again", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  store.reject(cs.id);

  const state = buildReviewState(store.findById(cs.id)!);
  assert.ok(state.lines.some((l) => l.text.includes("Optional")), "the old code is still shown after reject");
  assert.equal(state.lines.some((l) => l.kind === "added"), false, "nothing is added after reject");
  assert.equal(state.pending, 0);
  // And the file on disk is back to the original.
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), OLD);
});

test("accepting a hunk makes the review state show only the new code", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  store.accept(cs.id);

  const state = buildReviewState(store.findById(cs.id)!);
  assert.equal(state.lines.some((l) => l.text.includes("Optional")), false, "the old code is gone after accept");
  assert.ok(state.lines.some((l) => l.text === "from typing import List, Sequence, Tuple" && l.kind === "added"));
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), NEW);
});

test("the review state carries one decision bar per hunk", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const state = buildReviewState(cs);
  assert.equal(state.hunks.length, cs.hunks.length);
  for (const h of state.hunks) {
    assert.ok(h.line >= 0 && h.line < state.lines.length, "the bar anchors on a real line");
  }
});

test("a fully-resolved change stays readable but has no pending hunks", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);
  store.reject(cs.id);

  const kept = store.findById(cs.id);
  assert.equal(kept?.status, "resolved");
  assert.equal(store.listChanges(ws).length, 0, "not listed as a pending change");

  const state = buildReviewState(kept!);
  assert.equal(state.status, "resolved");
  assert.equal(state.pending, 0);
  assert.ok(state.lines.length > 0, "the resolved state is still renderable");
});

test("a decided hunk is visibly decided in the review state", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  const pad = "pad\n".repeat(15);
  fs.writeFileSync(path.join(ws, "demo.py"), `A = 1\n${pad}B = 2\n`);
  const cs = store.propose(ws, "demo.py", `A = 111\n${pad}B = 222\n`);
  assert.equal(cs.hunks.length, 2, "two hunks, so one can stay pending");

  const before = buildReviewState(store.findById(cs.id)!);
  assert.deepEqual(before.hunks.map((h) => h.decision), ["pending", "pending"]);

  store.accept(cs.id, [cs.hunks[0].id]);
  const after = buildReviewState(store.findById(cs.id)!);
  assert.deepEqual(after.hunks.map((h) => h.decision), ["accepted", "pending"]);
  assert.equal(after.pending, 1);
});

test("the real file carries Accept/Reject CodeLens, and a decided hunk looks decided", () => {
  // Regression guard for "I click Accept and nothing happens", on the real file: this is the
  // provider's `file`-scheme branch, the only Accept/Reject surface outside the webviews.
  // (The old guard drove the merged authority, which this task removes.)
  const ws = tmp();
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  const store = new ChangeStore({ baseDir: tmp() });
  const pad = "pad\n".repeat(15);
  fs.writeFileSync(path.join(ws, "demo.py"), `A = 1\n${pad}B = 2\n`);
  const cs = store.propose(ws, "demo.py", `A = 111\n${pad}B = 222\n`);
  assert.equal(cs.hunks.length, 2, "two hunks, so one can stay pending");

  const lenses = new HunkCodeLensProvider(store);
  const doc = {
    uri: vscode.Uri.file(path.join(ws, "demo.py")),
    lineCount: 100,
  } as unknown as vscode.TextDocument;

  const titles = (): string[] =>
    lenses.provideCodeLenses(doc).map((l) => String((l.command as { title?: string } | undefined)?.title ?? ""));

  assert.ok(titles().some((t) => t.includes("$(check) Accept")), "pending shows the Accept button");
  assert.ok(!titles().some((t) => t.includes("Accepted")), "nothing is accepted yet");

  // Accept only the first hunk; the second stays pending, so the set is not resolved.
  store.accept(cs.id, [cs.hunks[0].id]);
  const after = titles();
  assert.ok(after.some((t) => t.includes("Accepted")), "the accepted hunk shows an 'Accepted' badge");
  assert.ok(after.some((t) => t.includes("Undo")), "the accepted hunk offers Undo");
  assert.ok(after.some((t) => t.includes("$(check) Accept")), "the still-pending hunk keeps its Accept button");
});
