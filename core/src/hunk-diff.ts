/**
 * Pure hunk diffing and resolution. No `vscode`, no filesystem — unit-testable on its own.
 *
 * The model: a file has a baseline O (last accepted checkpoint) and a proposed C
 * (what the agent wants). We compute line hunks between them. Each hunk carries a
 * decision. `resolve` rebuilds the file from O by replaying decisions, so accepting
 * or rejecting one hunk never shifts the line numbers of another.
 */
import { diffArrays } from "diff";
import type { ChangeOrigin, Hunk, HunkDecision } from "./types";

export interface ContentInfo {
  lines: string[];
  eol: "\n" | "\r\n";
  bom: boolean;
  finalNewline: boolean;
}

const BOM = "﻿";

export function detectEol(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  // Use CRLF only when CRLF actually dominates; a lone CRLF in an LF file should not flip it.
  return crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n";
}

/** Split raw file text into normalized lines plus the metadata needed to rebuild it byte-for-byte. */
export function splitContent(text: string): ContentInfo {
  let body = text;
  let bom = false;
  if (body.startsWith(BOM)) {
    bom = true;
    body = body.slice(1);
  }
  const eol = detectEol(body);
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const core = finalNewline ? normalized.slice(0, -1) : normalized;
  // A lone "\n" is ONE empty line, not an empty file — only truly empty text has no lines.
  // Treating it as zero lines made joinContent drop the newline, so a file that was just a
  // blank line could not be rebuilt (and a reject of one could silently empty it).
  const lines = core === "" && !finalNewline ? [] : core.split("\n");
  return { lines, eol, bom, finalNewline };
}

/** Rebuild raw file text from lines and metadata (inverse of splitContent). */
export function joinContent(lines: string[], info: Omit<ContentInfo, "lines">): string {
  if (lines.length === 0) {
    // Zero lines means an empty file, regardless of the finalNewline flag.
    return info.bom ? BOM : "";
  }
  let out = lines.join("\n");
  if (info.finalNewline) {
    out += "\n";
  }
  if (info.eol === "\r\n") {
    out = out.replace(/\n/g, "\r\n");
  }
  return info.bom ? BOM + out : out;
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function hunkId(oldStart: number, oldLines: string[], newLines: string[]): string {
  return hashString(`${oldStart}\u0002${oldLines.join("\u0000")}\u0001${newLines.join("\u0000")}`);
}

/**
 * Compute hunks between two line arrays. Adjacent removed+added parts merge into one
 * modify hunk so a single logical edit renders as one Accept/Reject pair.
 */
export function computeHunks(baselineLines: string[], proposedLines: string[]): Hunk[] {
  const parts = diffArrays(baselineLines, proposedLines);
  const hunks: Hunk[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.added || part.removed) {
      const oldStart = oldIdx;
      const newStart = newIdx;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (i < parts.length && (parts[i].added || parts[i].removed)) {
        const cur = parts[i];
        if (cur.removed) {
          oldLines.push(...cur.value);
          oldIdx += cur.value.length;
        } else {
          newLines.push(...cur.value);
          newIdx += cur.value.length;
        }
        i++;
      }
      hunks.push({
        id: hunkId(oldStart, oldLines, newLines),
        oldStart,
        oldLines,
        newStart,
        newLines,
        decision: "pending",
      });
    } else {
      oldIdx += part.value.length;
      newIdx += part.value.length;
      i++;
    }
  }
  return hunks;
}

/**
 * Which frame the on-disk content is in for a change set.
 *   "mcp" — the agent staged the edit, so the disk still holds the baseline: an
 *           undecided hunk must be anchored at its baseline lines.
 *   "fs"  — the agent wrote the file directly, so an undecided hunk is already on disk.
 * Every anchor (decorations, CodeLens, settle) must use this so the frames cannot drift.
 */
export function diskFrame(origin: ChangeOrigin): "baseline" | "proposed" {
  return origin === "mcp" ? "baseline" : "proposed";
}

/**
 * Rebuild file lines from the baseline by replaying each hunk's decision.
 * Hunks must be ordered by oldStart and non-overlapping (computeHunks guarantees this).
 *
 * `pendingMode` decides what an undecided hunk produces:
 *  - "proposed" (default): keep the new lines. Correct when the proposed content is
 *    already on disk (the apply-on-propose model) — an unreviewed hunk simply stays
 *    as the agent left it.
 *  - "baseline": keep the old lines. Correct when nothing has been written yet.
 *
 * Prefer `diskFrame(cs.origin)` to pick this for a change set.
 */
export function resolveLines(
  baselineLines: string[],
  hunks: Hunk[],
  pendingMode: "proposed" | "baseline" = "proposed",
): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const h of hunks) {
    while (cursor < h.oldStart) {
      out.push(baselineLines[cursor]);
      cursor++;
    }
    const keepNew = h.decision === "accepted" || (h.decision === "pending" && pendingMode === "proposed");
    if (keepNew) {
      out.push(...h.newLines);
    } else {
      out.push(...h.oldLines);
    }
    cursor = h.oldStart + h.oldLines.length;
  }
  while (cursor < baselineLines.length) {
    out.push(baselineLines[cursor]);
    cursor++;
  }
  return out;
}

/** Convenience: content-level diff -> hunks. */
export function diffContent(baseline: string, proposed: string): Hunk[] {
  return computeHunks(splitContent(baseline).lines, splitContent(proposed).lines);
}

export interface ResolvedHunkRange {
  id: string;
  /** 0-based line in the resolved document where this hunk's surviving content starts. */
  start: number;
  /** Number of lines this hunk contributes to the resolved document. */
  length: number;
  /** The lines this hunk contributes, in resolved order. */
  lines: string[];
}

/**
 * Where each hunk's surviving content lands in the resolved document.
 *
 * Decorations and CodeLens on the *real* file need this: a hunk's `newStart` is a line
 * number in the fully-proposed document, which is only correct while every hunk is
 * pending or accepted. As soon as one hunk is rejected its line count changes, so every
 * hunk below it shifts — anchoring on `newStart` then puts the highlight and the
 * Accept/Reject buttons on the wrong lines.
 *
 * Prefer `diskFrame(cs.origin)` to pick `pendingMode` for a change set.
 */
export function resolveHunkRanges(
  baselineLines: string[],
  hunks: Hunk[],
  pendingMode: "proposed" | "baseline" = "proposed",
): ResolvedHunkRange[] {
  const out: ResolvedHunkRange[] = [];
  let cursor = 0;
  let resolved = 0;
  for (const h of hunks) {
    // Unchanged lines before this hunk.
    resolved += Math.max(0, h.oldStart - cursor);
    const keepNew = h.decision === "accepted" || (h.decision === "pending" && pendingMode === "proposed");
    const lines = keepNew ? h.newLines : h.oldLines;
    out.push({ id: h.id, start: resolved, length: lines.length, lines });
    resolved += lines.length;
    cursor = h.oldStart + h.oldLines.length;
  }
  return out;
}

/** Convenience: content-level resolve. */
export function resolveContent(
  baseline: string,
  proposed: string,
  hunks: Hunk[],
): string {
  const base = splitContent(baseline);
  const lines = resolveLines(base.lines, hunks);
  return joinContent(lines, { eol: base.eol, bom: base.bom, finalNewline: base.finalNewline });
}

/** Carry decisions forward across a rebase by matching hunk ids; unmatched hunks reset to pending. */
export function rebaseDecisions(oldHunks: Hunk[], newHunks: Hunk[]): Hunk[] {
  const byId = new Map<string, HunkDecision>();
  for (const h of oldHunks) {
    if (h.decision !== "pending") {
      byId.set(h.id, h.decision);
    }
  }
  return newHunks.map((h) => {
    const carried = byId.get(h.id);
    return carried ? { ...h, decision: carried } : h;
  });
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(hunks: Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.newLines.length;
    removed += h.oldLines.length;
  }
  return { added, removed };
}
