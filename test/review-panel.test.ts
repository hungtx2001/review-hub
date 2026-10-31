import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ReviewPanelProvider, type PanelActions } from "../vscode/src/ui/webview/review-panel";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-panel-"));
}

function actions(): PanelActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    acceptHunk: (c, h) => calls.push(`acceptHunk:${c}:${h}`),
    rejectHunk: (c, h) => calls.push(`rejectHunk:${c}:${h}`),
    acceptFile: (c) => calls.push(`acceptFile:${c}`),
    rejectFile: (c) => calls.push(`rejectFile:${c}`),
    acceptAll: () => calls.push("acceptAll"),
    rejectAll: () => calls.push("rejectAll"),
    openHunk: (c, h) => calls.push(`openHunk:${c}:${h}`),
    openDiff: (c) => calls.push(`openDiff:${c}`),
    setCheckpoint: () => calls.push("setCheckpoint"),
  };
}

function makeProvider() {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  const cs = store.propose(ws, "a.txt", "one\nTWO\n");
  const a = actions();
  const provider = new ReviewPanelProvider(
    vscode.Uri.file(process.cwd()),
    {
      workspaces: () => [ws],
      checkpoint: () => undefined,
      changeSets: () => store.listChangeSets(ws),
    },
    a,
  );
  // The stub's `registerWebviewViewProvider` resolves the view eagerly, so this call runs
  // `resolveWebviewView` and populates `__webviews` before we read it back.
  vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewType, provider);
  const view = (vscode as unknown as { __webviews: Map<string, { webview: { __receive(msg: unknown): void; html: string; posted: unknown[] } }> })
    .__webviews.get("review-hub.changes")!;
  return { provider, a, cs, store, view, ws };
}

test("the panel html loads the assets through a CSP with a nonce", () => {
  const { provider } = makeProvider();
  assert.ok(provider);
  const { __webviews } = vscode as unknown as { __webviews: Map<string, { webview: { html: string } }> };
  const view = __webviews.get("review-hub.changes")!;
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.match(view.webview.html, /nonce-/);
  assert.match(view.webview.html, /panel\.js/);
  assert.match(view.webview.html, /panel\.css/);
});

test("a webview command is routed to the matching action", () => {
  const { a, cs, view } = makeProvider();
  view.webview.__receive({ command: "acceptHunk", changeId: cs.id, hunkId: cs.hunks[0].id });
  assert.deepEqual(a.calls, [`acceptHunk:${cs.id}:${cs.hunks[0].id}`]);

  view.webview.__receive({ command: "rejectAll" });
  assert.equal(a.calls[1], "rejectAll");

  view.webview.__receive({ command: "openDiff", changeId: cs.id });
  assert.equal(a.calls[2], `openDiff:${cs.id}`);

  view.webview.__receive({ command: "setCheckpoint" });
  assert.equal(a.calls[3], "setCheckpoint");
});

test("an unknown or malformed webview command is ignored, not thrown", () => {
  const { a, view } = makeProvider();
  view.webview.__receive({ command: "nonsense" });
  view.webview.__receive({});
  view.webview.__receive(null);
  assert.deepEqual(a.calls, [], "nothing is dispatched");
});

test("refresh posts the panel state to the webview", () => {
  const { provider, view, cs } = makeProvider();
  // `refresh()` also runs once inside `resolveWebviewView`, so the view already holds one update.
  provider.refresh();
  const messages = view.webview.posted as { type: string; state: { totalFiles: number } }[];
  const update = messages.find((m) => m.type === "update");
  assert.ok(update, "an update message was posted");
  assert.equal(update!.state.totalFiles, 1);
  assert.ok(cs.hunks.length === 1);
});
