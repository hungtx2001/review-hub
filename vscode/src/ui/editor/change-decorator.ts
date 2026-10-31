/**
 * Inline change highlighting on the real file in the editor.
 *
 * When a file with a change set is open, we decorate the changed line ranges
 * (background + gutter icon + overview ruler) and attach per-hunk Accept/Reject
 * CodeLens directly on the file — so the user sees and resolves the change without
 * leaving the file, not only in the separate diff view.
 *
 * The disk holds the baseline plus the hunks the user has accepted — for an "mcp" change
 * nothing else is written, while an "fs" change was written directly by the agent. Which
 * frame that is comes from `diskFrame(origin)`, and a pending hunk is only absent from disk
 * in the "baseline" frame. A hunk that is not on disk cannot have a coloured row: its
 * removal (or insertion) is previewed as ghost text, since VS Code injected text must be a
 * single line.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "../../../../core/src/change-store";
import type { ChangeSet, Hunk } from "../../../../core/src/types";
import { splitContent, diskFrame, resolveHunkRanges } from "../../../../core/src/hunk-diff";
import { buildStagedView, stagedMarks, type StagedMark } from "./staged-content";

/** Red/green foregrounds for the single-line ghost text, so a deletion reads as red. */
const DELETED_COLOR = new vscode.ThemeColor("gitDecoration.deletedResourceForeground");
const ADDED_COLOR = new vscode.ThemeColor("gitDecoration.addedResourceForeground");

export class ChangeDecorator implements vscode.Disposable {
  private added: vscode.TextEditorDecorationType;
  private removed: vscode.TextEditorDecorationType;
  /** A pure deletion has no surviving line to colour, so it gets a boundary marker. */
  private deletionMarker: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private store: ChangeStore,
    /** True while this file's buffer holds the merged view (Task 2). */
    private isStaged: (fsPath: string) => boolean = () => false,
  ) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      // A left border marks the block's extent even when the themed background is subtle.
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    });
    // A pending hunk's removal, or an accepted hunk's already-removed lines, cannot be a
    // coloured row: the lines are not on disk. Their text is shown as ghost text after the
    // anchor line, in red (removed) or green (added), with an overview-ruler mark so the
    // deletion is discoverable from the scrollbar too.
    this.deletionMarker = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.apply(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.apply(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === e.document);
        if (editor) {
          this.apply(editor);
        }
      }),
    );
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  /** Re-apply decorations to any visible editor showing the given change's file. */
  refresh(changeId: string): void {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === cs.absPath) {
        this.apply(editor);
      }
    }
  }

  /** Clear decorations on every visible editor (e.g. after a checkpoint). */
  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  private changeForDocument(editor: vscode.TextEditor): ChangeSet | undefined {
    if (editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const isWin = process.platform === "win32";
    const fsPath = editor.document.uri.fsPath.replace(/\\/g, "/");
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const root = ws.uri.fsPath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      const compFs = isWin ? fsPath.toLowerCase() : fsPath;
      const compRoot = isWin ? root.toLowerCase() : root;
      if (!compFs.startsWith(compRoot + "/")) {
        continue;
      }
      const rel = fsPath.slice(root.length + 1);
      const cs = this.store.findChangeByPath(ws.uri.fsPath, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  }

  private apply(editor: vscode.TextEditor): void {
    const cs = this.changeForDocument(editor);
    if (!cs) {
      this.clear(editor);
      return;
    }
    // A staged buffer contains BOTH sides of every hunk, so each block can be a real colour
    // row — the thing a plain highlight structurally cannot do (see the module header).
    if (this.isStaged(editor.document.uri.fsPath)) {
      this.applyStaged(editor, cs);
      return;
    }
    if (cs.binary || cs.hunks.length === 0) {
      this.clear(editor);
      return;
    }
    const doc = editor.document;
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const deleted: vscode.DecorationOptions[] = [];

    // The frame the disk is in depends on the change's origin (see `diskFrame`): for an
    // "mcp" change the disk holds the baseline, so a hunk's range is its baseline lines;
    // for an "fs" change the agent wrote the file directly, so a pending hunk is already
    // on disk and its range is the proposed one. Anchoring in the wrong frame colours the
    // wrong lines as soon as one hunk above is decided.
    const frame = diskFrame(cs.origin);
    const pendingOnDisk = frame === "proposed";
    const ranges = new Map(
      resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, frame).map((r) => [r.id, r]),
    );

    const lastLine = Math.max(0, doc.lineCount - 1);
    for (const hunk of cs.hunks) {
      const label = hunkLabel(cs, hunk);
      const range = ranges.get(hunk.id);
      const start = clamp(range?.start ?? hunk.newStart, 0, lastLine);
      // The resolved range's length is exactly how many of this hunk's lines are on disk.
      const span = range ? range.length : hunk.oldLines.length;
      // A hunk's *new* lines are on disk when it was accepted, or when it is still pending
      // in a frame where pending means "the agent's write is already there".
      const newOnDisk = hunk.decision === "accepted" || (hunk.decision === "pending" && pendingOnDisk);

      // GREEN — the new lines, which really are on disk now.
      if (newOnDisk && span > 0) {
        const end = clamp(start + span - 1, start, lastLine);
        added.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // RED — a rejected hunk put the baseline lines back, so colour them to show the
      // rejection took effect.
      if (hunk.decision === "rejected") {
        const redSpan = Math.max(1, span || hunk.newLines.length || hunk.oldLines.length);
        const end = clamp(start + redSpan - 1, start, lastLine);
        removed.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // GHOST — only what the user cannot see in the file. Red for a removal, green for an
      // insertion, so a deletion reads as red even though it cannot have a red row.
      if (newOnDisk) {
        // The new lines are visible, so the old ones are really gone: show what was removed.
        if (hunk.oldLines.length > 0) {
          deleted.push({
            range: new vscode.Range(start, 0, start, 0),
            hoverMessage: removedHover(label, hunk.oldLines),
            renderOptions: { after: { contentText: ghostFor(hunk.oldLines), color: DELETED_COLOR } },
          });
        }
      } else if (hunk.decision === "pending" && hunk.oldLines.length > 0) {
        // Nothing written yet: preview the removal the user would be accepting.
        deleted.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: pendingHover(label, hunk.oldLines, hunk.newLines),
          renderOptions: { after: { contentText: ghostFor(hunk.oldLines), color: DELETED_COLOR } },
        });
      } else if (hunk.decision === "pending" && hunk.newLines.length > 0) {
        // Nothing written yet: preview the insertion the user would be accepting.
        deleted.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: pendingHover(label, hunk.oldLines, hunk.newLines),
          renderOptions: { after: { contentText: addedGhostFor(hunk.newLines), color: ADDED_COLOR } },
        });
      }
    }
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.deletionMarker, deleted);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.removed, []);
    editor.setDecorations(this.deletionMarker, []);
  }

  /** Staged view: `deleted` blocks red, `added` blocks green, no ghost text (spec D2). */
  private applyStaged(editor: vscode.TextEditor, cs: ChangeSet): void {
    const view = buildStagedView(cs);
    if (!view) {
      this.clear(editor);
      return;
    }
    const marks = stagedMarks(view, editor.document.lineCount);
    const hunks = new Map(cs.hunks.map((h) => [h.id, h]));
    const decorate = (list: StagedMark[]): vscode.DecorationOptions[] =>
      list.flatMap((mark) => {
        const hunk = hunks.get(mark.hunkId);
        if (!hunk) {
          return [];
        }
        return [
          {
            range: new vscode.Range(mark.start, 0, mark.end, 0),
            hoverMessage: stagedHover(hunkLabel(cs, hunk), hunk),
          },
        ];
      });
    editor.setDecorations(this.added, decorate(marks.added));
    editor.setDecorations(this.removed, decorate(marks.removed));
    editor.setDecorations(this.deletionMarker, []);
  }

  dispose(): void {
    this.added.dispose();
    this.removed.dispose();
    this.deletionMarker.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Ghost text for a removed line (or lines). VS Code injected text must be a single line,
 * so one removed line is shown verbatim and several are summarised with the first shown
 * and the rest counted; the full text is on the decoration's hover.
 *
 * Leading whitespace in `contentText` is collapsed by the renderer, so indentation is
 * rebuilt from non-breaking spaces (U+2003) to keep the removed code readable.
 */
export function ghostFor(oldLines: string[]): string {
  const raw = (oldLines[0] ?? "").replace(/\t/g, "    ");
  const indent = raw.length - raw.trimStart().length;
  const body = raw.trimStart();
  const shown = body.length > 100 ? `${body.slice(0, 100)}…` : body;
  // An em-space is about two columns wide, so halve the indent to keep it looking right.
  const pad = " ".repeat(Math.min(Math.ceil(indent / 2), 20));
  const more = oldLines.length > 1 ? `  ⊖ +${oldLines.length - 1} more deleted` : "";
  return `  ⊖ ${pad}${shown}${more}`;
}

/** Ghost text for a pending insertion — the lines that would land if the user accepts. */
export function addedGhostFor(newLines: string[]): string {
  const raw = (newLines[0] ?? "").replace(/\t/g, "    ");
  const indent = raw.length - raw.trimStart().length;
  const body = raw.trimStart();
  const shown = body.length > 100 ? `${body.slice(0, 100)}…` : body;
  const pad = "\u2003".repeat(Math.min(Math.ceil(indent / 2), 20));
  const more = newLines.length > 1 ? `  ⊕ +${newLines.length - 1} more added` : "";
  return `  ⊕ ${pad}${shown}${more}`;
}

/** Hover for a pending hunk: both sides, so the user can read what would change. */
function pendingHover(label: string, oldLines: string[], newLines: string[]): vscode.MarkdownString {
  const block = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : ["", `**${title}:**`, "```", ...lines.map((l) => l.replace(/\t/g, "    ")), "```"];
  return new vscode.MarkdownString(
    [
      label,
      ...block("Will be removed if accepted", oldLines),
      ...block("Will be added if accepted", newLines),
    ].join("\n"),
  );
}

/** Hover for a ghost decoration: the full text of every removed line. */
function removedHover(label: string, oldLines: string[]): vscode.MarkdownString {
  return new vscode.MarkdownString(
    [label, "", "**Removed:**", "```", ...oldLines.map((l) => l.replace(/\t/g, "    ")), "```"].join("\n"),
  );
}

/** Staged hover: the hunk label plus both sides, worded for the hunk's current decision. */
function stagedHover(label: string, hunk: Hunk): vscode.MarkdownString {
  const block = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : ["", `**${title}:**`, "```", ...lines.map((l) => l.replace(/\t/g, "    ")), "```"];
  if (hunk.decision === "accepted") {
    return new vscode.MarkdownString([label, ...block("Removed from the baseline", hunk.oldLines)].join("\n"));
  }
  if (hunk.decision === "rejected") {
    return new vscode.MarkdownString([label, ...block("Discarded (the baseline was kept)", hunk.newLines)].join("\n"));
  }
  return new vscode.MarkdownString(
    [label, ...block("Old code (red block)", hunk.oldLines), ...block("New code (green block)", hunk.newLines)].join(
      "\n",
    ),
  );
}

function hunkLabel(cs: ChangeSet, hunk: Hunk): string {
  const decision =
    hunk.decision === "accepted" ? "accepted" : hunk.decision === "rejected" ? "rejected" : "pending review";
  const origin = cs.origin === "mcp" ? "from agent" : "direct write";
  const added = hunk.newLines.length;
  const removed = hunk.oldLines.length;
  return [
    `**Review Hub** — ${origin} · ${decision}`,
    "",
    `\`+${added} −${removed}\``,
    "",
    "Use the Accept / Reject buttons above to resolve this hunk.",
  ].join("\n");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
