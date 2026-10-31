/**
 * The sidebar panel: a hunkwise-style review list in the `review-hub` activity-bar
 * container, replacing the native tree in `src/changes-tree.ts`.
 *
 * The panel is a pure renderer. It receives a serialisable `PanelState` and posts
 * commands back; every command is forwarded to `PanelActions`, which the extension wires
 * to the same `ChangeStore` calls the commands already use. Inbound messages use
 * `type`, outbound use `command` — hunkwise's convention.
 */
import * as vscode from "vscode";
import { buildPanelState, type PanelSource } from "./review-panel-state";
import { webviewHtml } from "./webview-html";

export interface PanelActions {
  acceptHunk(changeId: string, hunkId: string): void;
  rejectHunk(changeId: string, hunkId: string): void;
  acceptFile(changeId: string): void;
  rejectFile(changeId: string): void;
  acceptAll(): void;
  rejectAll(): void;
  openHunk(changeId: string, hunkId: string): void;
  openDiff(changeId: string): void;
  setCheckpoint(): void;
}

interface PanelMessage {
  command?: string;
  changeId?: string;
  hunkId?: string;
}

export class ReviewPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "review-hub.changes";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: PanelSource,
    private readonly actions: PanelActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources"), vscode.Uri.joinPath(this.extensionUri, "vscode", "resources")],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, "panel", {
      html: "panel.html",
      css: "panel.css",
      js: "panel.js",
    });
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    this.refresh();
  }

  /** Re-render with the current state. A no-op before the view is resolved. */
  refresh(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    void view.webview.postMessage({ type: "update", state: buildPanelState(this.source) });
  }

  private onMessage(msg: PanelMessage | null | undefined): void {
    if (!msg || typeof msg !== "object" || typeof msg.command !== "string") {
      return;
    }
    const changeId = typeof msg.changeId === "string" ? msg.changeId : "";
    const hunkId = typeof msg.hunkId === "string" ? msg.hunkId : "";
    switch (msg.command) {
      case "ready":
        this.refresh();
        return;
      case "acceptHunk":
        if (changeId && hunkId) this.actions.acceptHunk(changeId, hunkId);
        return;
      case "rejectHunk":
        if (changeId && hunkId) this.actions.rejectHunk(changeId, hunkId);
        return;
      case "acceptFile":
        if (changeId) this.actions.acceptFile(changeId);
        return;
      case "rejectFile":
        if (changeId) this.actions.rejectFile(changeId);
        return;
      case "acceptAll":
        this.actions.acceptAll();
        return;
      case "rejectAll":
        this.actions.rejectAll();
        return;
      case "openHunk":
        if (changeId) this.actions.openHunk(changeId, hunkId);
        return;
      case "openDiff":
        if (changeId) this.actions.openDiff(changeId);
        return;
      case "setCheckpoint":
        this.actions.setCheckpoint();
        return;
      default:
        return;
    }
  }
}
