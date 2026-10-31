import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStagedText,
  buildStagedView,
  pendingCount,
  stageSkipReason,
  stagedCountTitle,
  stagedMarks,
} from "../vscode/src/ui/editor/staged-content";
import type { ChangeSet, Hunk } from "../core/src/types";

const BASELINE = "one\ntwo\nthree\n";
const PROPOSED = "one\nTWO\nthree\n";

function hunk(overrides: Partial<Hunk> = {}): Hunk {
  return {
    id: "h1",
    oldStart: 1,
    oldLines: ["two"],
    newStart: 1,
    newLines: ["TWO"],
    decision: "pending",
    ...overrides,
  };
}

function makeChange(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "fs",
    applied: true,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: BASELINE,
    proposed: PROPOSED,
    baselineExists: true,
    proposedExists: true,
    hunks: [hunk()],
    status: "applied",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("a pending change is stageable when auto-save is off", () => {
  assert.equal(stageSkipReason(makeChange(), "off"), undefined);
});

test("binary, hunk-less, fully decided and auto-save changes are refused", () => {
  assert.equal(stageSkipReason(makeChange({ binary: true }), "off"), "binary");
  assert.equal(stageSkipReason(makeChange({ hunks: [] }), "off"), "no-hunks");
  assert.equal(
    stageSkipReason(makeChange({ hunks: [hunk({ decision: "accepted" })] }), "off"),
    "already-decided",
  );
  assert.equal(stageSkipReason(makeChange(), "afterDelay"), "auto-save");
});

test("the staged text puts the old code directly above the new code", () => {
  assert.equal(buildStagedText(makeChange()), "one\ntwo\nTWO\nthree\n");
});

test("an accepted hunk shows only the new code, a rejected one only the old", () => {
  assert.equal(buildStagedText(makeChange({ hunks: [hunk({ decision: "accepted" })] })), PROPOSED);
  assert.equal(buildStagedText(makeChange({ hunks: [hunk({ decision: "rejected" })] })), BASELINE);
});

test("the fully accepted staged text is byte-identical to the proposed file", () => {
  // The invariant that lets Task 2's `restage()` hand the buffer back to disk: once no hunk
  // is pending, the view IS the resolved file, so unstage + revert cannot lose anything.
  const cs = makeChange({ hunks: [hunk({ decision: "accepted" })] });
  assert.equal(buildStagedText(cs), cs.proposed);

  // The proposal changed the framing alongside the text (BOM + CRLF). The framing rule must
  // mirror `resolvedMeta()` in src/change-store.ts — the PROPOSAL's framing once every hunk
  // is accepted, the BASELINE's while anything is pending or rejected — otherwise the buffer
  // would diverge from what `settle()` wrote (spec F2: a save is only allowed when the
  // buffer is byte-identical to disk).
  const framed = makeChange({
    baseline: "a\nb\n",
    proposed: "\uFEFFA\r\nb\r\n",
    eol: "\r\n",
    bom: true,
    finalNewline: true,
    hunks: [{ id: "f1", oldStart: 0, oldLines: ["a"], newStart: 0, newLines: ["A"], decision: "accepted" }],
  });
  assert.equal(buildStagedText(framed), framed.proposed, "accepted: proposed framing (BOM + CRLF)");

  const pending = { ...framed, hunks: [{ ...framed.hunks[0], decision: "pending" as const }] };
  assert.equal(
    buildStagedText(pending),
    "a\nA\nb\n",
    "pending: baseline framing (LF, no BOM) even though the proposal wanted CRLF",
  );

  const rejected = { ...framed, hunks: [{ ...framed.hunks[0], decision: "rejected" as const }] };
  assert.equal(buildStagedText(rejected), "a\nb\n", "rejected: baseline framing");

  // A new file has no baseline framing to keep: the buffer carries the proposal's framing
  // even while the hunk is still pending.
  const created = makeChange({
    baseline: "",
    proposed: "\uFEFFx\r\n",
    eol: "\r\n",
    bom: true,
    baselineExists: false,
    hunks: [{ id: "n1", oldStart: 0, oldLines: [], newStart: 0, newLines: ["x"], decision: "pending" }],
  });
  assert.equal(buildStagedText(created), created.proposed, "new file: proposed framing while pending");
});

test("a CRLF file keeps its line endings in the staged text", () => {
  const cs = makeChange({ baseline: "one\r\ntwo\r\nthree\r\n", eol: "\r\n" });
  assert.equal(buildStagedText(cs), "one\r\ntwo\r\nTWO\r\nthree\r\n");
});

test("binary and hunk-less changes have no staged view", () => {
  assert.equal(buildStagedView(makeChange({ binary: true })), undefined);
  assert.equal(buildStagedText(makeChange({ binary: true })), undefined);
  assert.equal(buildStagedText(makeChange({ hunks: [] })), undefined);
});

test("pendingCount counts only undecided hunks", () => {
  assert.equal(pendingCount(makeChange()), 1);
  assert.equal(
    pendingCount(
      makeChange({ hunks: [hunk({ decision: "accepted" }), hunk({ id: "h2", decision: "rejected" })] }),
    ),
    0,
  );
});

test("the count lens reads like a diff stat", () => {
  assert.equal(stagedCountTitle(4, 2), "−4 lines, +2 lines");
  assert.equal(stagedCountTitle(0, 3), "+3 lines");
  assert.equal(stagedCountTitle(5, 0), "−5 lines");
  assert.equal(stagedCountTitle(1, 1), "−1 line, +1 line");
});

test("stagedMarks colours the old block red and the new block green", () => {
  const view = buildStagedView(makeChange());
  assert.ok(view, "a pending change must have a staged view");
  const marks = stagedMarks(view!, 4);
  assert.deepEqual(marks.removed, [{ start: 1, end: 1, hunkId: "h1" }]);
  assert.deepEqual(marks.added, [{ start: 2, end: 2, hunkId: "h1" }]);
});

test("stagedMarks never leaves the document and skips context blocks", () => {
  const view = buildStagedView(makeChange());
  assert.ok(view);
  const marks = stagedMarks(view!, 2); // a document shorter than the view: every index clamps
  assert.equal(marks.removed.length, 1);
  assert.ok(marks.removed[0].start <= 1 && marks.removed[0].end <= 1);
  assert.equal(marks.added[0].end <= 1, true);
  assert.equal(view!.blocks.some((b) => b.kind === "context" && b.hunkId), false);
});
