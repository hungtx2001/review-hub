import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ChangeDecorator } from "../vscode/src/ui/editor/change-decorator";
import { buildStagedText } from "../vscode/src/ui/editor/staged-content";

const OLD = "one\ntwo\nthree\n";
const NEW = "one\nTWO\nthree\n";

interface Call {
  colorId: string;
  lines: [number, number][];
}

function setup(): { ws: string; store: ChangeStore; fsPath: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-dec-"));
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-dec-home-")) });
  fs.writeFileSync(path.join(ws, "a.txt"), OLD);
  store.propose(ws, "a.txt", NEW);
  return { ws, store, fsPath: path.join(ws, "a.txt") };
}

function show(fsPath: string, lineCount: number, calls: Call[]): void {
  vscode.__visibleEditors.length = 0;
  vscode.__decorationTypes.length = 0;
  vscode.__visibleEditors.push({
    document: { uri: { scheme: "file", fsPath }, lineCount },
    setDecorations: (
      type: { opts?: { backgroundColor?: { id?: string } } },
      options: { range?: { startLine: number; endLine: number } }[],
    ) => {
      calls.push({
        colorId: type.opts?.backgroundColor?.id ?? "none",
        lines: (options ?? []).map((o) => [o.range!.startLine, o.range!.endLine]),
      });
    },
  });
}

function byColor(calls: Call[]): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  for (const call of calls) {
    map.set(call.colorId, [...(map.get(call.colorId) ?? []), ...call.lines]);
  }
  return map;
}

test("a staged file gets a green row for the new code and a red row for the old", () => {
  const { store, fsPath } = setup();
  const stagedText = buildStagedText(store.findChangeByPath(path.dirname(fsPath), "a.txt")!)!;
  const calls: Call[] = [];
  show(fsPath, stagedText.split("\n").length, calls);

  const decorator = new ChangeDecorator(store, () => true);
  decorator.start();
  decorator.dispose();

  const colors = byColor(calls);
  assert.deepEqual(colors.get("diffEditor.insertedLineBackground"), [[2, 2]], "line 2 is the new code");
  assert.deepEqual(colors.get("diffEditor.removedLineBackground"), [[1, 1]], "line 1 is the old code");
  const ghost = calls.find((c) => c.colorId === "none");
  assert.deepEqual(ghost?.lines, [], "both sides are visible, so there is no ghost preview");
});

test("an unstaged file keeps today's ghost-text behaviour", () => {
  const { store, fsPath } = setup();
  const calls: Call[] = [];
  show(fsPath, OLD.split("\n").length, calls);

  const decorator = new ChangeDecorator(store, () => false);
  decorator.start();
  decorator.dispose();

  const colors = byColor(calls);
  assert.deepEqual(
    colors.get("diffEditor.insertedLineBackground"),
    [],
    "no green row: the pending new line is not on disk yet",
  );
  assert.ok((colors.get("none") ?? []).length > 0, "the pending hunk still gets its ghost preview");
});

test("a file with no change gets no decorations at all", () => {
  const { store, ws } = setup();
  const other = path.join(ws, "untouched.txt");
  const calls: Call[] = [];
  show(other, 3, calls);

  const decorator = new ChangeDecorator(store, () => true);
  decorator.start();
  decorator.dispose();

  assert.deepEqual(byColor(calls).get("diffEditor.insertedLineBackground"), [], "cleared, never coloured");
  assert.deepEqual(byColor(calls).get("diffEditor.removedLineBackground"), [], "cleared, never coloured");
});
