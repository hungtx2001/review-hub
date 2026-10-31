/**
 * The "merged" inline review view: a single document that shows, for every hunk, the
 * baseline lines that were removed (rendered red) immediately followed by the proposed
 * lines that were added (rendered green), interleaved with the unchanged context lines
 * around them — the same shape as Antigravity's inline diff, and the reason the user can
 * see old and new code at once.
 *
 * A decision changes what a hunk shows:
 *   pending  -> the old lines, then the new lines
 *   accepted -> only the new lines (the old ones are gone, as on disk)
 *   rejected -> only the old lines (the new ones are gone, as on disk)
 *
 * Pure: no `vscode`, no filesystem, so it is unit-testable on its own.
 */
import type { Hunk, HunkDecision } from "./types";

export type MergedBlockKind = "context" | "deleted" | "added";

export interface MergedBlock {
  kind: MergedBlockKind;
  /** Inclusive first line index in the merged document. */
  start: number;
  /** Exclusive last line index in the merged document. */
  end: number;
  /** The hunk this block renders; context blocks belong to no hunk. */
  hunkId?: string;
}

export interface MergedHunk {
  id: string;
  decision: HunkDecision;
  /** Line the Accept/Reject CodeLens attaches to (the hunk's first line). */
  anchor: number;
  /** Number of baseline lines this hunk removes. */
  removed: number;
  /** Number of proposed lines this hunk adds. */
  added: number;
}

export interface MergedView {
  lines: string[];
  blocks: MergedBlock[];
  hunks: MergedHunk[];
}

/**
 * Build the merged view from a baseline line array and the change's hunks.
 * `hunks` need not be sorted; they are ordered by `oldStart` here.
 */
export function buildMergedView(baselineLines: string[], hunks: Hunk[]): MergedView {
  const lines: string[] = [];
  const blocks: MergedBlock[] = [];
  const outHunks: MergedHunk[] = [];

  const push = (kind: MergedBlockKind, from: string[], hunkId?: string): void => {
    if (from.length === 0) {
      return;
    }
    const start = lines.length;
    lines.push(...from);
    blocks.push({ kind, start, end: lines.length, hunkId });
  };

  let cursor = 0;
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  for (const h of ordered) {
    // Unchanged lines between the previous hunk and this one.
    push("context", baselineLines.slice(cursor, h.oldStart));
    const anchor = lines.length;
    if (h.decision === "rejected") {
      push("deleted", h.oldLines, h.id);
    } else if (h.decision === "accepted") {
      push("added", h.newLines, h.id);
    } else {
      push("deleted", h.oldLines, h.id);
      push("added", h.newLines, h.id);
    }
    outHunks.push({
      id: h.id,
      decision: h.decision,
      anchor,
      removed: h.oldLines.length,
      added: h.newLines.length,
    });
    cursor = h.oldStart + h.oldLines.length;
  }
  push("context", baselineLines.slice(cursor));

  return { lines, blocks, hunks: outHunks };
}
