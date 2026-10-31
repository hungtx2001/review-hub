import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks, resolveLines, splitContent, joinContent, diffContent, resolveContent, rebaseDecisions } from "../core/src/hunk-diff";

test("identical content produces no hunks", () => {
  assert.equal(computeHunks(["a", "b"], ["a", "b"]).length, 0);
});

test("pure insertion is one hunk with empty oldLines", () => {
  const hunks = computeHunks(["a", "c"], ["a", "b", "c"]);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].oldLines, []);
  assert.deepEqual(hunks[0].newLines, ["b"]);
  assert.equal(hunks[0].oldStart, 1);
});

test("pure deletion is one hunk with empty newLines", () => {
  const hunks = computeHunks(["a", "b", "c"], ["a", "c"]);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].oldLines, ["b"]);
  assert.deepEqual(hunks[0].newLines, []);
});

test("a modify merges into a single hunk", () => {
  const hunks = computeHunks(["a", "b", "c"], ["a", "B", "c"]);
  assert.equal(hunks.length, 1, "removed+added should merge");
  assert.deepEqual(hunks[0].oldLines, ["b"]);
  assert.deepEqual(hunks[0].newLines, ["B"]);
});

test("accepting one hunk of many resolves only that hunk", () => {
  const base = ["line1", "line2", "line3", "line4"];
  const prop = ["LINE1", "line2", "line3", "LINE4"];
  const hunks = computeHunks(base, prop);
  assert.equal(hunks.length, 2);
  const decided = hunks.map((h, i) => ({ ...h, decision: i === 0 ? ("accepted" as const) : ("rejected" as const) }));
  assert.deepEqual(resolveLines(base, decided), ["LINE1", "line2", "line3", "line4"]);
});

test("pending keeps proposed by default; baseline mode keeps old lines", () => {
  const base = ["a", "b"];
  const prop = ["a", "X"];
  const hunks = computeHunks(base, prop);
  // Default: the proposed content is on disk, so an undecided hunk stays as proposed.
  assert.deepEqual(resolveLines(base, hunks), prop);
  // Explicit baseline mode: an undecided hunk falls back to the old lines.
  assert.deepEqual(resolveLines(base, hunks, "baseline"), base);
});

test("accept all equals proposed; reject all equals baseline", () => {
  const base = ["a", "b", "c", "d"];
  const prop = ["a", "B", "c", "D", "e"];
  const hunks = computeHunks(base, prop);
  const accepted = hunks.map((h) => ({ ...h, decision: "accepted" as const }));
  const rejected = hunks.map((h) => ({ ...h, decision: "rejected" as const }));
  assert.deepEqual(resolveLines(base, accepted), prop);
  assert.deepEqual(resolveLines(base, rejected), base);
});

test("new file: rejecting every hunk yields an empty file", () => {
  const hunks = computeHunks([], ["x", "y"]);
  assert.equal(hunks.length, 1);
  const rejected = hunks.map((h) => ({ ...h, decision: "rejected" as const }));
  assert.deepEqual(resolveLines([], rejected), []);
  const accepted = hunks.map((h) => ({ ...h, decision: "accepted" as const }));
  assert.deepEqual(resolveLines([], accepted), ["x", "y"]);
});

test("CRLF file round-trips and diffs without a whole-file change", () => {
  const base = "a\r\nb\r\nc\r\n";
  const prop = "a\r\nB\r\nc\r\n";
  const hunks = diffContent(base, prop);
  assert.equal(hunks.length, 1, "EOL difference must not create extra hunks");
  const decided = hunks.map((h) => ({ ...h, decision: "accepted" as const }));
  assert.equal(resolveContent(base, prop, decided), prop);
});

test("BOM is preserved", () => {
  const base = "﻿a\nb\n";
  const info = splitContent(base);
  assert.equal(info.bom, true);
  assert.equal(joinContent(info.lines, info), base);
});

test("missing final newline is preserved", () => {
  const base = "a\nb";
  const info = splitContent(base);
  assert.equal(info.finalNewline, false);
  assert.equal(joinContent(info.lines, info), base);
});

test("rebaseDecisions carries decisions by hunk id", () => {
  const base = ["a", "b", "c"];
  const first = computeHunks(base, ["a", "B", "c"]);
  const accepted = first.map((h) => ({ ...h, decision: "accepted" as const }));
  const again = computeHunks(base, ["a", "B", "c"]);
  const rebased = rebaseDecisions(accepted, again);
  assert.equal(rebased[0].decision, "accepted");
});
