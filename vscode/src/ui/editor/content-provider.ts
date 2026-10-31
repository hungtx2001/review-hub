/**
 * Virtual documents for the diff view. `review-hub://baseline/<changeId>` and
 * `review-hub://proposed/<changeId>` serve the two sides of a change, so VS Code's
 * built-in diff can render them. Mirrors Antigravity's jetski-diff scheme.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "../../../../core/src/change-store";

export const SCHEME = "review-hub";

export class ChangeContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  /**
   * The property name is load-bearing: VS Code discovers a content provider's change
   * event as `onDidChange`, not `onDidChangeTextDocument` (that is the *workspace* event).
   * With the wrong name the provider still serves content, but VS Code never re-queries it,
   * so an open side-by-side view keeps showing the pre-decision content — the
   * "Accept does nothing, it just sits there" symptom.
   */
  readonly onDidChange = this.emitter.event;

  constructor(private store: ChangeStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const side = uri.authority;
    const changeId = uri.path.replace(/^\//, "");
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "";
    }
    if (side === "baseline") {
      return cs.binary ? "(binary file)" : cs.baseline;
    }
    if (cs.binary) {
      return "(binary file)";
    }
    return cs.proposed;
  }

  baselineUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://baseline/${changeId}`);
  }

  proposedUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://proposed/${changeId}`);
  }

  /** Notify VS Code that every side changed so open views re-render. */
  refresh(changeId: string): void {
    this.emitter.fire(this.baselineUri(changeId));
    this.emitter.fire(this.proposedUri(changeId));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
