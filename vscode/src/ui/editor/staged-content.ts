/**
 * What goes into the editor buffer for a file under inline staged review, and how that
 * buffer maps back onto decorations and CodeLenses.
 *
 * Pure: no `vscode`, no filesystem. `src/staged-review.ts` owns the staging state machine
 * and `src/extension.ts` owns the host; this module is only the content model, so the
 * "the buffer must never be wrong" rules are unit-testable on their own.
 *
 * The staged text is the merged view (old block above new block for a pending hunk) framed
 * the way `settle()` frames the resolved file (`resolvedMeta()` in src/change-store.ts): the
 * BASELINE's framing while any hunk is pending or rejected, the PROPOSAL's framing once
 * every hunk is accepted (and for a new file, which has no baseline framing to keep). That
 * is what keeps the buffer byte-identical to the file `settle()` wrote, which is what lets
 * the engine hand the buffer back to disk safely (spec F2).
 */
import { buildMergedView, type MergedView } from "../../../../core/src/merged-diff";
import { joinContent, splitContent } from "../../../../core/src/hunk-diff";
import type { ChangeSet } from "../../../../core/src/types";

export type StageSkipReason = "binary" | "no-hunks" | "already-decided" | "auto-save";

/**
 * Why a change cannot be staged right now, or `undefined` when it can.
 * `autoSave` is the raw `files.autoSave` value; anything other than `"off"` means a timer
 * could flush the buffer, so staging is off entirely (spec D5/F4).
 */
export function stageSkipReason(cs: ChangeSet, autoSave: string): StageSkipReason | undefined {
  if (cs.binary) {
    return "binary";
  }
  if (cs.hunks.length === 0) {
    return "no-hunks";
  }
  if (!cs.hunks.some((h) => h.decision === "pending")) {
    return "already-decided";
  }
  return autoSave === "off" ? undefined : "auto-save";
}

/** The interleaved old/new view, or `undefined` when there is nothing to show. */
export function buildStagedView(cs: ChangeSet): MergedView | undefined {
  if (cs.binary || cs.hunks.length === 0) {
    return undefined;
  }
  return buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
}

/** The buffer content for a staged file: the merged view framed as `settle()` frames the resolved file. */
export function buildStagedText(cs: ChangeSet): string | undefined {
  if (cs.binary || cs.hunks.length === 0) {
    return undefined;
  }
  const base = splitContent(cs.baseline);
  const view = buildMergedView(base.lines, cs.hunks);
  // Mirror `resolvedMeta()` in src/change-store.ts: once every hunk is accepted (or the file
  // is new, so there is no baseline framing to keep), the resolved file carries the
  // PROPOSAL's framing; a partial or rejected decision keeps the BASELINE's framing so the
  // lines the user never touched are not converted.
  const framing =
    !cs.baselineExists || cs.hunks.every((h) => h.decision === "accepted")
      ? { eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline }
      : { eol: base.eol, bom: base.bom, finalNewline: base.finalNewline };
  return joinContent(view.lines, framing);
}

export function pendingCount(cs: ChangeSet): number {
  return cs.hunks.filter((h) => h.decision === "pending").length;
}

/** Title for the count lens: `−4 lines, +2 lines`. */
export function stagedCountTitle(removed: number, added: number): string {
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(`−${removed} line${removed === 1 ? "" : "s"}`);
  }
  if (added > 0) {
    parts.push(`+${added} line${added === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export interface StagedMark {
  /** Inclusive first line of the block. */
  start: number;
  /** Inclusive last line of the block (clamped to the document). */
  end: number;
  hunkId: string;
}

export interface StagedMarks {
  added: StagedMark[];
  removed: StagedMark[];
}

/**
 * Line ranges to colour in a staged buffer. `deleted` blocks are baseline code (red),
 * `added` blocks are proposed code (green) — the merged view only emits a deleted block for
 * a pending/rejected hunk and an added block for a pending/accepted one, so colouring by
 * kind reproduces exactly the semantics the unstaged decorations already use.
 */
export function stagedMarks(view: MergedView, docLineCount: number): StagedMarks {
  const lastLine = Math.max(0, docLineCount - 1);
  const clamp = (n: number): number => Math.max(0, Math.min(lastLine, n));
  const marks: StagedMarks = { added: [], removed: [] };
  for (const block of view.blocks) {
    if (block.kind === "context" || !block.hunkId || block.end <= block.start) {
      continue;
    }
    const mark: StagedMark = { start: clamp(block.start), end: clamp(block.end - 1), hunkId: block.hunkId };
    (block.kind === "added" ? marks.added : marks.removed).push(mark);
  }
  return marks;
}
