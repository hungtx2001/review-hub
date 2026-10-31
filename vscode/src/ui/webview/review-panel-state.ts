/**
 * The serialisable state objects the two webviews render.
 *
 * Both builders are pure — no `vscode`, no DOM, no filesystem — so the panel and the
 * review tab stay dumb renderers and their state is unit-testable without a webview.
 *
 * `buildPanelState` produces the sidebar's nested view (workspace → file → hunk).
 * `buildReviewState` produces the review tab's flat line list, reusing `buildMergedView`
 * so the diff logic is not duplicated in JavaScript.
 */
import { buildMergedView } from "../../../../core/src/merged-diff";
import { diffStats, splitContent } from "../../../../core/src/hunk-diff";
import type { ChangeSet, ChangeStatus, CheckpointInfo, HunkDecision } from "../../../../core/src/types";

export interface PanelSource {
  workspaces(): string[];
  checkpoint(workspace: string): CheckpointInfo | undefined;
  changeSets(workspace: string): ChangeSet[];
}

export interface PanelHunk {
  id: string;
  /** 1-based line number in the baseline where this hunk starts. */
  anchorLine: number;
  added: number;
  removed: number;
  decision: HunkDecision;
}

export interface PanelFile {
  id: string;
  path: string;
  name: string;
  dir: string;
  added: number;
  removed: number;
  pending: number;
  accepted: number;
  rejected: number;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: PanelHunk[];
}

export interface PanelGroup {
  workspace: string;
  label: string;
  files: PanelFile[];
}

export interface PanelState {
  groups: PanelGroup[];
  totalFiles: number;
  added: number;
  removed: number;
  checkpoint: CheckpointInfo | undefined;
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function dirName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

function fileOf(cs: ChangeSet): PanelFile {
  const stats = diffStats(cs.hunks);
  return {
    id: cs.id,
    path: cs.path,
    name: baseName(cs.path),
    dir: dirName(cs.path),
    added: stats.added,
    removed: stats.removed,
    pending: cs.hunks.filter((h) => h.decision === "pending").length,
    accepted: cs.hunks.filter((h) => h.decision === "accepted").length,
    rejected: cs.hunks.filter((h) => h.decision === "rejected").length,
    binary: cs.binary,
    isNew: !cs.baselineExists && cs.proposedExists,
    isDeleted: cs.baselineExists && !cs.proposedExists,
    hunks: cs.hunks.map((h) => ({
      id: h.id,
      anchorLine: h.oldStart + 1,
      added: h.newLines.length,
      removed: h.oldLines.length,
      decision: h.decision,
    })),
  };
}

export function buildPanelState(source: PanelSource): PanelState {
  const groups: PanelGroup[] = [];
  let totalFiles = 0;
  let added = 0;
  let removed = 0;
  let checkpoint: CheckpointInfo | undefined;

  for (const workspace of source.workspaces()) {
    const sets = source.changeSets(workspace);
    if (sets.length === 0) {
      continue;
    }
    checkpoint = checkpoint ?? source.checkpoint(workspace);
    const files = sets.map(fileOf);
    for (const f of files) {
      totalFiles++;
      added += f.added;
      removed += f.removed;
    }
    groups.push({ workspace, label: baseName(workspace), files });
  }

  if (checkpoint === undefined) {
    checkpoint = source.checkpoint(source.workspaces()[0] ?? "");
  }
  return { groups, totalFiles, added, removed, checkpoint };
}

export interface ReviewLine {
  kind: "context" | "deleted" | "added";
  text: string;
}

export interface ReviewHunk {
  id: string;
  /** Index into `lines` where this hunk's decision bar belongs. */
  line: number;
  decision: HunkDecision;
  added: number;
  removed: number;
}

export interface ReviewState {
  changeId: string;
  name: string;
  dir: string;
  binary: boolean;
  status: ChangeStatus;
  lines: ReviewLine[];
  hunks: ReviewHunk[];
  added: number;
  removed: number;
  pending: number;
}

export function buildReviewState(cs: ChangeSet): ReviewState {
  const stats = diffStats(cs.hunks);
  const base = {
    changeId: cs.id,
    name: baseName(cs.path),
    dir: dirName(cs.path),
    binary: cs.binary,
    status: cs.status,
    added: stats.added,
    removed: stats.removed,
    pending: cs.hunks.filter((h) => h.decision === "pending").length,
  };
  if (cs.binary) {
    // A binary file has no lines to show; the panel's accept/reject is the whole story.
    return { ...base, lines: [], hunks: [] };
  }
  const view = buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
  const lines: ReviewLine[] = [];
  for (const block of view.blocks) {
    for (let i = block.start; i < block.end; i++) {
      lines.push({ kind: block.kind, text: view.lines[i] });
    }
  }
  return {
    ...base,
    lines,
    hunks: view.hunks.map((h) => ({
      id: h.id,
      line: h.anchor,
      decision: h.decision,
      added: h.added,
      removed: h.removed,
    })),
  };
}
