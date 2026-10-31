import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPanelState, buildReviewState, type PanelSource } from "../vscode/src/ui/webview/review-panel-state";
import type { ChangeSet } from "../core/src/types";

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "src/app.ts",
    absPath: "/ws/src/app.ts",
    origin: "mcp",
    applied: false,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "a\nb\nc\n",
    proposed: "a\nB\nc\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [
      { id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "pending" },
    ],
    status: "pending",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function source(sets: ChangeSet[]): PanelSource {
  return {
    workspaces: () => ["/ws"],
    checkpoint: () => ({ workspace: "/ws", setAt: 1000, files: 7 }),
    changeSets: (ws) => (ws === "/ws" ? sets : []),
  };
}

test("the panel totals files and added/removed lines across workspaces", () => {
  const state = buildPanelState(source([changeSet()]));
  assert.equal(state.totalFiles, 1);
  assert.equal(state.added, 1);
  assert.equal(state.removed, 1);
  assert.equal(state.checkpoint?.files, 7);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].label, "ws");
});

test("a file row splits its name from its directory", () => {
  const state = buildPanelState(source([changeSet()]));
  const file = state.groups[0].files[0];
  assert.equal(file.name, "app.ts");
  assert.equal(file.dir, "src");
  assert.equal(file.pending, 1);
  assert.equal(file.binary, false);
});

test("a hunk row carries a 1-based anchor line and its own counts", () => {
  const state = buildPanelState(source([changeSet()]));
  const hunk = state.groups[0].files[0].hunks[0];
  assert.equal(hunk.anchorLine, 2, "oldStart 1 becomes line 2");
  assert.equal(hunk.added, 1);
  assert.equal(hunk.removed, 1);
  assert.equal(hunk.decision, "pending");
});

test("a brand-new file is flagged and gets no directory", () => {
  const cs = changeSet({
    baseline: "",
    baselineExists: false,
    path: "new.ts",
    proposed: "x\n",
    hunks: [{ id: "h1", oldStart: 0, oldLines: [], newStart: 0, newLines: ["x"], decision: "pending" }],
  });
  const state = buildPanelState(source([cs]));
  const file = state.groups[0].files[0];
  assert.equal(file.isNew, true);
  assert.equal(file.isDeleted, false);
  assert.equal(file.dir, "");
});

test("a deleted file is flagged", () => {
  const cs = changeSet({
    proposed: "",
    proposedExists: false,
    hunks: [{ id: "h1", oldStart: 0, oldLines: ["a", "b", "c"], newStart: 0, newLines: [], decision: "pending" }],
  });
  assert.equal(buildPanelState(source([cs])).groups[0].files[0].isDeleted, true);
});

test("an empty source yields an empty panel state", () => {
  const state = buildPanelState(source([]));
  assert.deepEqual(state.groups, []);
  assert.equal(state.totalFiles, 0);
  assert.equal(state.added, 0);
});

test("the review state tags every line with its block kind", () => {
  const state = buildReviewState(changeSet());
  assert.deepEqual(
    state.lines.map((l) => l.kind),
    ["context", "deleted", "added", "context"],
    "pending shows the old line then the new one",
  );
  assert.deepEqual(state.lines.map((l) => l.text), ["a", "b", "B", "c"]);
  assert.equal(state.hunks.length, 1);
  assert.equal(state.hunks[0].line, 1, "the hunk starts at line index 1");
  assert.equal(state.pending, 1);
});

test("an accepted hunk renders only its added lines", () => {
  const cs = changeSet({
    hunks: [{ id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "accepted" }],
  });
  const state = buildReviewState(cs);
  assert.deepEqual(state.lines.map((l) => l.kind), ["context", "added", "context"]);
  assert.equal(state.pending, 0);
});

test("a rejected hunk renders only its deleted lines", () => {
  const cs = changeSet({
    hunks: [{ id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "rejected" }],
  });
  const state = buildReviewState(cs);
  assert.deepEqual(state.lines.map((l) => l.kind), ["context", "deleted", "context"]);
});

test("a binary change renders a placeholder instead of a diff", () => {
  const state = buildReviewState(changeSet({ binary: true }));
  assert.equal(state.binary, true);
  assert.deepEqual(state.lines, []);
  assert.equal(state.hunks.length, 0);
});
