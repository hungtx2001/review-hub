/**
 * The review tab: the primary surface for a change. One webview panel per change, opened
 * from the sidebar panel, a file's badge, or `review-hub.openDiff`.
 *
 * This is where the multi-line red/green diff actually happens. A `TextEditorDecorationType`
 * cannot colour a line that is not on disk, and injected text must be a single line, so a
 * real red block of deleted lines is impossible in the editor buffer with stable APIs
 * (spec §2.1). A webview has no such limit.
 *
 * The line list comes from `buildReviewState`, which reuses the pure `buildMergedView`, so
 * no diff logic is duplicated in JavaScript.
 */
import * as vscode from "vscode";
import { buildReviewState } from "./review-panel-state";
import { webviewHtml } from "./webview-html";
import type { ChangeSet } from "../../../../core/src/types";

export interface TabSource {
  change(changeId: string): ChangeSet | undefined;
}

export interface TabActions {
  acceptHunk(changeId: string, hunkId: string): void;
  rejectHunk(changeId: string, hunkId: string): void;
  acceptFile(changeId: string): void;
  rejectFile(changeId: string): void;
}

interface TabMessage {
  command?: string;
  changeId?: string;
  hunkId?: string;
}

export class ReviewTab implements vscode.Disposable {
  static readonly viewType = "review-hub.review";
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: TabSource,
    private readonly actions: TabActions,
  ) {}

  /** Open (or reveal) the review tab for a change. */
  open(changeId: string, targetHunkId?: string): void {
    const existing = this.panels.get(changeId);
    if (existing) {
      existing.reveal();
      this.refresh(changeId, targetHunkId);
      return;
    }
    const cs = this.source.change(changeId);
    if (!cs) {
      void vscode.window.showWarningMessage(`Review Hub: change ${changeId} no longer exists.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ReviewTab.viewType,
      titleFor(cs),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources"), vscode.Uri.joinPath(this.extensionUri, "vscode", "resources")],
      },
    );
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, "review-tab", {
      html: "review.html",
      css: "review.css",
      js: "review.js",
    });
    panel.webview.onDidReceiveMessage((msg: TabMessage) => this.onMessage(msg));
    panel.onDidDispose(() => this.panels.delete(changeId));
    this.panels.set(changeId, panel);
    this.refresh(changeId, targetHunkId);
  }

  /** Re-post the state after a decision, and refresh the title with the new progress. */
  refresh(changeId: string, targetHunkId?: string): void {
    const panel = this.panels.get(changeId);
    if (!panel) {
      return;
    }
    const cs = this.source.change(changeId);
    if (!cs) {
      return;
    }
    panel.title = titleFor(cs);
    void panel.webview.postMessage({ type: "update", state: buildReviewState(cs), targetHunkId });
  }

  refreshAll(): void {
    for (const changeId of [...this.panels.keys()]) {
      this.refresh(changeId);
    }
  }

  close(changeId: string): void {
    const panel = this.panels.get(changeId);
    if (panel) {
      this.panels.delete(changeId);
      panel.dispose();
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private onMessage(msg: TabMessage | null | undefined): void {
    if (!msg || typeof msg !== "object" || typeof msg.command !== "string") {
      return;
    }
    const changeId = typeof msg.changeId === "string" ? msg.changeId : "";
    const hunkId = typeof msg.hunkId === "string" ? msg.hunkId : "";
    if (!changeId) {
      return;
    }
    switch (msg.command) {
      case "acceptHunk":
        if (hunkId) this.actions.acceptHunk(changeId, hunkId);
        return;
      case "rejectHunk":
        if (hunkId) this.actions.rejectHunk(changeId, hunkId);
        return;
      case "acceptFile":
        this.actions.acceptFile(changeId);
        return;
      case "rejectFile":
        this.actions.rejectFile(changeId);
        return;
      default:
        return;
    }
  }
}

/** `name (accepted/total)`, or `name ✓` once nothing is pending. */
function titleFor(cs: ChangeSet): string {
  const name = cs.path.split("/").pop() ?? cs.path;
  if (cs.hunks.length === 0) {
    return name;
  }
  const pending = cs.hunks.filter((h) => h.decision === "pending").length;
  if (pending === 0) {
    return `${name} ✓`;
  }
  const accepted = cs.hunks.filter((h) => h.decision === "accepted").length;
  return `${name} (${accepted}/${cs.hunks.length})`;
}
