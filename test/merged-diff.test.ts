import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergedView } from "../core/src/merged-diff";
import { computeHunks } from "../core/src/hunk-diff";
import type { Hunk } from "../core/src/types";

function hunksFor(base: string[], proposed: string[]): Hunk[] {
  return computeHunks(base, proposed);
}

test("merged view shows the old lines then the new lines for a pending hunk", () => {
  const base = ["a", "b", "c", "d"];
  const proposed = ["a", "B2", "c", "d"];
  const hunks = hunksFor(base, proposed);
  const view = buildMergedView(base, hunks);

  // "b" (old) is shown, then "B2" (new): both versions are visible at once.
  assert.deepEqual(view.lines, ["a", "b", "B2", "c", "d"]);
  assert.deepEqual(
    view.blocks.map((b) => b.kind),
    ["context", "deleted", "added", "context"],
  );
  assert.deepEqual(
    view.blocks.map((b) => [b.start, b.end]),
    [[0, 1], [1, 2], [2, 3], [3, 5]],
  );
  assert.equal(view.hunks.length, 1);
  assert.equal(view.hunks[0].anchor, 1, "the hunk anchors on its first (old) line");
  assert.equal(view.hunks[0].removed, 1);
  assert.equal(view.hunks[0].added, 1);
});

test("a rejected hunk shows only the old lines; an accepted hunk only the new", () => {
  const base = ["a", "b", "c"];
  const proposed = ["a", "B2", "c"];
  const pending = hunksFor(base, proposed);
  assert.deepEqual(buildMergedView(base, pending).lines, ["a", "b", "B2", "c"]);

  const rejected = pending.map((h) => ({ ...h, decision: "rejected" as const }));
  assert.deepEqual(buildMergedView(base, rejected).lines, ["a", "b", "c"]);

  const accepted = pending.map((h) => ({ ...h, decision: "accepted" as const }));
  assert.deepEqual(buildMergedView(base, accepted).lines, ["a", "B2", "c"]);
});

test("an insertion shows the new lines with no deleted block", () => {
  const base = ["a", "c"];
  const proposed = ["a", "b", "c"];
  const view = buildMergedView(base, hunksFor(base, proposed));
  assert.deepEqual(view.lines, ["a", "b", "c"]);
  assert.deepEqual(
    view.blocks.map((b) => b.kind),
    ["context", "added", "context"],
  );
});

test("a deletion shows the old lines with no added block", () => {
  const base = ["a", "b", "c"];
  const proposed = ["a", "c"];
  const view = buildMergedView(base, hunksFor(base, proposed));
  assert.deepEqual(view.lines, ["a", "b", "c"]);
  assert.deepEqual(
    view.blocks.map((b) => b.kind),
    ["context", "deleted", "context"],
  );
});

test("multiple hunks interleave with the context between them", () => {
  const base = ["1", "2", "3", "4", "5", "6", "7"];
  const proposed = ["1", "two", "3", "4", "5", "six", "7"];
  const view = buildMergedView(base, hunksFor(base, proposed));
  assert.deepEqual(view.lines, ["1", "2", "two", "3", "4", "5", "6", "six", "7"]);
  assert.equal(view.hunks.length, 2);
  assert.equal(view.hunks[0].anchor, 1);
  assert.equal(view.hunks[1].anchor, 6, "the second hunk's anchor accounts for the first hunk's added lines");
});

test("a new file (no baseline) shows every line as added", () => {
  const view = buildMergedView([], hunksFor([], ["x", "y"]));
  assert.deepEqual(view.lines, ["x", "y"]);
  assert.deepEqual(view.blocks.map((b) => b.kind), ["added"]);
  assert.equal(view.hunks[0].anchor, 0);
});

test("no hunks means the baseline is shown unchanged", () => {
  const view = buildMergedView(["a", "b"], []);
  assert.deepEqual(view.lines, ["a", "b"]);
  assert.deepEqual(view.blocks.map((b) => b.kind), ["context"]);
  assert.equal(view.hunks.length, 0);
});

test("every non-context block carries the hunk it belongs to", () => {
  const view = buildMergedView(["one", "two", "three"], [
    {
      id: "h1",
      oldStart: 1,
      oldLines: ["two"],
      newStart: 1,
      newLines: ["TWO"],
      decision: "pending",
    },
  ]);
  assert.deepEqual(
    view.blocks.map((b) => b.hunkId),
    [undefined, "h1", "h1", undefined],
    "context blocks have no hunk; the red and green blocks of a hunk share its id",
  );
});
