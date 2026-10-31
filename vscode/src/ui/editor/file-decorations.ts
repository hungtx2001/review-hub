/**
 * Explorer decorations: a coloured badge on every file an agent has changed, so the user
 * can see *which files* need review without opening a diff.
 *
 * Đây là yêu cầu "chỉ báo luôn hiển thị" (always visible indicator). Huy hiệu (badge) mô phỏng
 * quy ước của git (M/A/D) để nhận biết ngay lập tức, và `propagate` đặt một dấu chấm trên
 * thư mục chứa, giúp thay đổi nằm sâu trong cây thư mục vẫn nhìn thấy được khi thư mục bị thu gọn.
 *
 * A file drops out of the decoration set as soon as every hunk is decided — the store hides
 * resolved change sets from `findChangeByPath`, so "badge present" means "still to review".
 */
import * as vscode from "vscode";
import type { ChangeStore } from "../../../../core/src/change-store";

export class ChangeFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  // `undefined` means "re-evaluate every URI", which is what we want after any decision.
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private store: ChangeStore, private getWorkspaces: () => string[]) {}

  /** Re-evaluate every visible file's decoration. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const cs = this.changeFor(uri.fsPath);
    if (!cs) {
      return undefined;
    }
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    if (pending === 0) {
      // Every hunk decided: the change is settled, so it is no longer "needs review".
      return undefined;
    }
    const added = cs.hunks.reduce((n, h) => n + h.newLines.length, 0);
    const removed = cs.hunks.reduce((n, h) => n + h.oldLines.length, 0);

    // Git's letters, so the meaning is obvious at a glance.
    const letter = !cs.baselineExists ? "A" : !cs.proposedExists ? "D" : "M";
    const color =
      letter === "A"
        ? new vscode.ThemeColor("gitDecoration.addedResourceForeground")
        : letter === "D"
          ? new vscode.ThemeColor("gitDecoration.deletedResourceForeground")
          : new vscode.ThemeColor("gitDecoration.modifiedResourceForeground");

    return {
      badge: letter,
      color,
      propagate: true,
      tooltip: `Review Hub: ${pending} hunk${pending === 1 ? "" : "s"} pending (+${added} −${removed}) — click to review`,
    };
  }

  private changeFor(fsPath: string): ReturnType<ChangeStore["findChangeByPath"]> {
    const isWin = process.platform === "win32";
    const normFs = fsPath.replace(/\\/g, "/");
    for (const ws of this.getWorkspaces()) {
      const root = ws.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      const compFs = isWin ? normFs.toLowerCase() : normFs;
      const compRoot = isWin ? root.toLowerCase() : root;
      if (!compFs.startsWith(compRoot + "/")) {
        continue;
      }
      const rel = normFs.slice(root.length + 1);
      const cs = this.store.findChangeByPath(ws, rel) ?? this.store.findChangeByPath(root, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
