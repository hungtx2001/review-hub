/**
 * The review surfaces for a change.
 *
 * Primary: the **review tab** (`src/review-tab.ts`), which renders old and new code
 * together per hunk with its own decision bars.
 *
 * This file owns the classic side-by-side `vscode.diff` of baseline vs proposed, plus the
 * per-hunk Accept/Reject CodeLens on the real file itself.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "../../../../core/src/change-store";
import type { ChangeContentProvider } from "./content-provider";
import { splitContent, diskFrame, resolveHunkRanges } from "../../../../core/src/hunk-diff";
import { buildStagedView, stagedCountTitle } from "./staged-content";
import type { Hunk } from "../../../../core/src/types";

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private store: ChangeStore,
    /** True while this file's buffer holds the merged view (Task 2). */
    private isStaged: (fsPath: string) => boolean = () => false,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri;

    // The virtual "proposed" side of a side-by-side diff.
    if (uri.scheme === "review-hub" && uri.authority === "proposed") {
      const changeId = uri.path.replace(/^\//, "");
      const cs = this.store.findById(changeId);
      if (!cs || cs.binary) {
        return [];
      }
      return cs.hunks.flatMap((hunk, index) =>
        this.lensesFor(cs, hunk, index, hunk.newStart, document, cs.hunks.length),
      );
    }

    // The real file, so Accept/Reject is available without opening any review tab.
    // Anchor in the frame the disk is actually in (`diskFrame`): the baseline frame for a
    // staged "mcp" change, the proposed frame for an "fs" change the agent wrote directly.
    // Using the wrong frame puts the buttons on the wrong line as soon as one hunk above
    // is decided, since that changes how many lines it contributes.
    if (uri.scheme === "file") {
      const cs = this.changeForFile(uri.fsPath);
      if (!cs || cs.binary) {
        return [];
      }
      // Staged: the buffer IS the merged view, so the anchor is a merged-view line and the
      // diff stat is the block's own size (spec D3).
      if (this.isStaged(uri.fsPath)) {
        const view = buildStagedView(cs);
        if (!view) {
          return [];
        }
        return view.hunks.flatMap((h, index) => {
          const hunk = cs.hunks.find((x) => x.id === h.id);
          return hunk
            ? this.lensesFor(cs, hunk, index, h.anchor, document, cs.hunks.length, {
                removed: h.removed,
                added: h.added,
              })
            : [];
        });
      }
      const ranges = new Map(
        resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, diskFrame(cs.origin)).map((r) => [r.id, r]),
      );
      return cs.hunks.flatMap((hunk, index) => {
        const anchor = ranges.get(hunk.id)?.start ?? hunk.newStart;
        return this.lensesFor(cs, hunk, index, anchor, document, cs.hunks.length);
      });
    }
    return [];
  }

  private changeForFile(fsPath: string): ReturnType<ChangeStore["findChangeByPath"]> {
    const isWin = process.platform === "win32";
    const normFs = fsPath.replace(/\\/g, "/");
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const root = ws.uri.fsPath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      const compFs = isWin ? normFs.toLowerCase() : normFs;
      const compRoot = isWin ? root.toLowerCase() : root;
      if (!compFs.startsWith(compRoot + "/")) {
        continue;
      }
      const rel = normFs.slice(root.length + 1);
      const cs = this.store.findChangeByPath(ws.uri.fsPath, rel) ?? this.store.findChangeByPath(root, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  }

  private lensesFor(
    cs: NonNullable<ReturnType<ChangeStore["findById"]>>,
    hunk: NonNullable<ReturnType<ChangeStore["findById"]>>["hunks"][number],
    index: number,
    anchorLine: number,
    document: vscode.TextDocument,
    total: number,
    counts?: { removed: number; added: number },
  ): vscode.CodeLens[] {
    const line = clamp(anchorLine, 0, Math.max(0, document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);

    // A resolved change set is shown read-only: the decision is already on disk, so
    // offering Accept/Reject again would be misleading.
    if (cs.status === "resolved") {
      const what = hunk.decision === "accepted" ? "✓ kept (accepted)" : "✗ reverted (rejected)";
      return [
        new vscode.CodeLens(range, {
          title: `Review Hub · hunk ${index + 1}/${total} · ${what}`,
          command: "",
        }),
      ];
    }

    // A decided hunk must LOOK decided. Previously it kept the same Accept/Reject buttons
    // as a pending hunk (only a non-clickable label changed), so a click produced no
    // visible change, the user clicked again, and nothing happened because the hunk was
    // already accepted. Now the resolved side becomes a static badge and the other side
    // turns into "Undo", which both confirms the click and offers a way back.
    if (hunk.decision === "accepted") {
      return [
        new vscode.CodeLens(range, {
          title: "$(check) Accepted",
          command: "",
          tooltip: "This hunk's new lines are kept",
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Undo",
          command: "review-hub.rejectHunk",
          arguments: [cs.id, hunk.id],
          tooltip: "Undo — restore this hunk's baseline lines",
        }),
        new vscode.CodeLens(range, {
          title: `hunk ${index + 1}/${total} · ✓ accepted`,
          command: "",
        }),
      ];
    }

    if (hunk.decision === "rejected") {
      return [
        new vscode.CodeLens(range, {
          title: "$(chrome-close) Rejected",
          command: "",
          tooltip: "This hunk was restored to its baseline",
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Undo",
          command: "review-hub.acceptHunk",
          arguments: [cs.id, hunk.id],
          tooltip: "Undo — keep this hunk's new lines instead",
        }),
        new vscode.CodeLens(range, {
          title: `hunk ${index + 1}/${total} · ✗ rejected`,
          command: "",
        }),
      ];
    }

    return [
      new vscode.CodeLens(range, {
        title: "$(check) Accept",
        command: "review-hub.acceptHunk",
        arguments: [cs.id, hunk.id],
        tooltip: "Keep this hunk's proposed lines",
      }),
      new vscode.CodeLens(range, {
        title: "$(chrome-close) Reject",
        command: "review-hub.rejectHunk",
        arguments: [cs.id, hunk.id],
        tooltip: "Restore this hunk's baseline lines",
      }),
      new vscode.CodeLens(range, {
        title: counts ? stagedCountTitle(counts.removed, counts.added) : `hunk ${index + 1}/${total} · pending`,
        command: "",
        tooltip: counts ? oldCodeTooltip(hunk) : undefined,
      }),
    ];
  }
}

/**
 * Owns the classic side-by-side `vscode.diff` of baseline vs proposed.
 */
export class DiffView implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private store: ChangeStore,
    private provider: ChangeContentProvider,
    private codeLens: HunkCodeLensProvider,
    private onDidChange: () => void,
  ) {}

  /** Open the classic side-by-side diff (baseline | proposed). */
  async openSideBySide(changeId: string): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      void vscode.window.showWarningMessage(`Review Hub: change ${changeId} no longer exists.`);
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.provider.baselineUri(changeId),
      this.provider.proposedUri(changeId),
      this.titleFor(changeId),
    );
  }

  titleFor(changeId: string): string {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "Review Hub";
    }
    // Keep the tab title short: just the file name plus progress. A long title
    // pushes the other tabs off-screen when the editor group is narrow.
    const name = cs.path.split("/").pop() ?? cs.path;
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    const accepted = cs.hunks.filter((h) => h.decision === "accepted").length;
    if (cs.hunks.length === 0) {
      return name;
    }
    if (pending === 0) {
      return `${name} ✓`;
    }
    return `${name} (${accepted}/${cs.hunks.length})`;
  }

  /**
   * After a decision: refresh the virtual docs and the lens, and reopen the side-by-side
   * tab so the title reflects the new state (VS Code has no rename API for an editor tab).
   */
  async refresh(changeId: string): Promise<void> {
    this.provider.refresh(changeId);
    this.codeLens.refresh();
    this.onDidChange();
    await this.retitle(changeId);
  }

  private async retitle(changeId: string): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return;
    }
    let sideBySide = false;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri } | undefined;
        const id = (u?: vscode.Uri) => u?.scheme === "review-hub" && u.path.replace(/^\//, "") === changeId;
        if (input?.modified?.scheme === "review-hub" && id(input.modified)) {
          await vscode.window.tabGroups.close(tab, true);
          sideBySide = true;
        }
      }
    }
    if (sideBySide) {
      await this.openSideBySide(changeId);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Old code in a lens tooltip, so a block the eye skims is still readable. */
function oldCodeTooltip(hunk: Hunk): string | undefined {
  if (hunk.oldLines.length === 0) {
    return undefined;
  }
  const old = hunk.oldLines.map((l) => l.replace(/\t/g, "    ")).join("\n");
  return `Old code (removed if accepted):\n${old}`;
}
