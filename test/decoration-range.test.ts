import { test } from "node:test";
import assert from "node:assert/strict";
import { diskFrame, resolveHunkRanges, splitContent } from "../core/src/hunk-diff";

/**
 * Real-file decorations under review-then-apply. Which frame the disk is in depends on the
 * change's origin (`diskFrame`): an "mcp" change is staged, so the disk holds the BASELINE
 * plus the hunks the user has accepted; an "fs" change was written directly by the agent,
 * so a pending hunk is already on disk in the PROPOSED frame.
 *
 * In the baseline frame (mcp):
 *   accepted — the new lines are on disk -> green background; the removed old lines are
 *              gone, so they are shown as red ghost text (`⊖`).
 *   pending  — the baseline lines are still on disk -> no background; the removal is
 *              previewed as red ghost text, or the insertion as green ghost text (`⊕`).
 *   rejected — the baseline lines are back and visible -> red background, so the user can
 *              see the rejection took effect. No ghost.
 *
 * In the proposed frame (fs) a pending hunk behaves like an accepted one: its new lines are
 * on disk, so it is green and its removed lines are ghosted in red.
 *
 * Mirrors `ChangeDecorator.apply`, which needs the full editor surface to import.
 */

interface Hunk {
  id: string;
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  decision: "pending" | "accepted" | "rejected";
}

interface Mark {
  added: [number, number][];
  removed: [number, number][];
  ghost: { line: number; kind: "removed" | "added" }[];
}

const BASELINE = ["a", "b", "c"];

function marksFor(hunks: Hunk[], docLineCount: number, frame: "baseline" | "proposed" = "baseline"): Mark {
  const lastLine = Math.max(0, docLineCount - 1);
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const pendingOnDisk = frame === "proposed";
  const ranges = new Map(resolveHunkRanges(BASELINE, hunks as never, frame).map((r) => [r.id, r]));
  const out: Mark = { added: [], removed: [], ghost: [] };
  for (const h of hunks) {
    const range = ranges.get(h.id);
    const start = clamp(range?.start ?? h.newStart, 0, lastLine);
    const span = range ? range.length : h.oldLines.length;
    const newOnDisk = h.decision === "accepted" || (h.decision === "pending" && pendingOnDisk);
    if (newOnDisk && span > 0) {
      out.added.push([start, clamp(start + span - 1, start, lastLine)]);
    }
    if (h.decision === "rejected") {
      const redSpan = Math.max(1, span || h.newLines.length || h.oldLines.length);
      out.removed.push([start, clamp(start + redSpan - 1, start, lastLine)]);
    }
    if (newOnDisk) {
      // The new lines are visible, so only a removal is worth ghosting.
      if (h.oldLines.length > 0) {
        out.ghost.push({ line: start, kind: "removed" });
      }
    } else if (h.decision === "pending" && h.oldLines.length > 0) {
      out.ghost.push({ line: start, kind: "removed" });
    } else if (h.decision === "pending" && h.newLines.length > 0) {
      out.ghost.push({ line: start, kind: "added" });
    }
  }
  return out;
}

const h = (over: Partial<Hunk>): Hunk => ({
  id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B2"], decision: "pending", ...over,
});

test("a pending modify shows a red ghost of the removed line and nothing green", () => {
  const m = marksFor([h({})], 3);
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the line that would be replaced is previewed in red");
  assert.deepEqual(m.added, [], "nothing is on disk yet, so nothing is green");
  assert.deepEqual(m.removed, []);
});

test("a pending pure insertion shows a green ghost", () => {
  const m = marksFor([h({ oldLines: [], newLines: ["b"] })], 3);
  assert.deepEqual(m.ghost, [{ line: 1, kind: "added" }], "the pending addition is previewed in green");
  assert.deepEqual(m.added, [], "it is not on disk yet");
});

test("an accepted hunk is green on disk and shows the removed line as a red ghost", () => {
  const m = marksFor([h({ decision: "accepted" })], 3);
  assert.deepEqual(m.added, [[1, 1]], "the new line is on disk");
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the old line is gone, so it is ghosted in red");
});

test("a rejected hunk is red on the restored baseline line and has no ghost", () => {
  const m = marksFor([h({ decision: "rejected" })], 3);
  assert.deepEqual(m.removed, [[1, 1]], "the baseline line is back on disk and marked red");
  assert.deepEqual(m.ghost, [], "the old line is really on disk again");
  assert.deepEqual(m.added, []);
});

test("accepting an insertion writes it and shows no ghost", () => {
  const m = marksFor([h({ oldLines: [], newLines: ["b"], decision: "accepted" })], 3);
  assert.deepEqual(m.added, [[1, 1]]);
  assert.deepEqual(m.ghost, [], "nothing was removed");
});

test("a multi-line pending deletion is one red ghost at its anchor", () => {
  const m = marksFor([h({ oldLines: ["x", "y", "z"], newLines: [] })], 5);
  assert.equal(m.ghost.length, 1);
  assert.equal(m.ghost[0].kind, "removed");
});

test("a rejected hunk below an accepted one anchors in the baseline frame", () => {
  // accept a one-line insertion at the top: it contributes 1 line. The second hunk's
  // baseline line 3 lands at resolved line 3, not at its proposed line 4.
  const hunks: Hunk[] = [
    h({ id: "top", oldStart: 0, oldLines: [], newStart: 0, newLines: ["new"], decision: "accepted" }),
    h({ id: "bot", oldStart: 2, oldLines: ["c"], newStart: 3, newLines: ["C2"], decision: "rejected" }),
  ];
  const m = marksFor(hunks, 4);
  assert.deepEqual(m.removed, [[3, 3]], "the rejected hunk is anchored on baseline line 3");
});

// ---- the fs frame (the agent wrote the file directly) -------------------------

test("diskFrame maps mcp to the baseline frame and fs to the proposed frame", () => {
  // The single source of truth for the frame rule, shared by settle, the decorations and
  // the CodeLens, so the three can never drift apart.
  assert.equal(diskFrame("mcp"), "baseline", "a staged change leaves the disk on the baseline");
  assert.equal(diskFrame("fs"), "proposed", "a direct write is already on disk");
});

test("an fs pending hunk is already on disk: green row and red ghost in the proposed frame", () => {
  const m = marksFor([h({})], 3, "proposed");
  assert.deepEqual(m.added, [[1, 1]], "the agent's write is on disk, so the new line is green");
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the replaced old line is gone: red ghost");
  assert.deepEqual(m.removed, [], "nothing was rejected");
});

test("the same pending hunks anchor differently in the two frames", () => {
  const hunks: Hunk[] = [
    h({ id: "ins", oldStart: 0, oldLines: [], newStart: 0, newLines: ["x"] }),
    h({ id: "rep", oldStart: 2, oldLines: ["c"], newStart: 3, newLines: ["C2"] }),
  ];

  // mcp (baseline frame): the disk holds the baseline, so the insertion is a green ghost
  // and the replacement still sits on baseline line 3 (0-based 2).
  const mcp = marksFor(hunks, 3, "baseline");
  assert.deepEqual(mcp.added, [], "nothing is on disk for a staged change");
  assert.deepEqual(mcp.ghost, [
    { line: 0, kind: "added" },
    { line: 2, kind: "removed" },
  ]);

  // fs (proposed frame): the agent's write is already on disk, so both hunks are green and
  // the replacement is anchored one line lower, at its proposed line 4 (0-based 3).
  const fs = marksFor(hunks, 4, "proposed");
  assert.deepEqual(fs.added, [[0, 0], [3, 3]], "both hunks are on disk");
  assert.deepEqual(fs.ghost, [{ line: 3, kind: "removed" }], "the replaced line is ghosted at its real position");
});

// ---- ghost text formatting ---------------------------------------------------

test("ghost text shows a single removed line", async () => {
  const { ghostFor } = await import("../vscode/src/ui/editor/change-decorator");
  assert.equal(ghostFor(["import sys"]), "  ⊖ import sys");
});

test("ghost text preserves indentation with non-breaking spaces", async () => {
  const { ghostFor } = await import("../vscode/src/ui/editor/change-decorator");
  const out = ghostFor(["        return None"]);
  assert.equal(out, "  \u2296 \u2003\u2003\u2003\u2003return None");
});

test("ghost text summarises a multi-line deletion", async () => {
  const { ghostFor } = await import("../vscode/src/ui/editor/change-decorator");
  const out = ghostFor(["first", "second", "third"]);
  assert.match(out, /first/);
  assert.match(out, /\+2 more deleted/);
});

test("ghost text truncates a very long line", async () => {
  const { ghostFor } = await import("../vscode/src/ui/editor/change-decorator");
  const out = ghostFor(["x".repeat(300)]);
  assert.ok(out.includes("…"), "long lines are truncated");
  assert.ok(out.length < 200);
});

test("added ghost text uses the ⊕ marker", async () => {
  const { addedGhostFor } = await import("../vscode/src/ui/editor/change-decorator");
  assert.equal(addedGhostFor(["import sys"]), "  ⊕ import sys");
  assert.match(addedGhostFor(["a", "b"]), /\+1 more added/);
});

// keep `splitContent` referenced so an unused-import error cannot slip in
test("splitContent is available for the anchor math", () => {
  assert.deepEqual(splitContent("a\nb\n").lines, ["a", "b"]);
});
