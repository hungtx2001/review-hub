import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The extension imports `vscode`, which the test runner aliases to test/vscode-stub.ts.
// Point HOME at a temp dir so ~/.review-hub is sandboxed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ext-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.REVIEW_HUB_DIR = path.join(home, ".review-hub");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ext-ws-"));
fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
process.env.VSCODE_STUB_CONFIG = JSON.stringify({ enabled: true, watchDirectWrites: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require("./vscode-stub") as {
  __commands: Map<string, unknown[]>;
  __webviews: Map<string, unknown>;
  Uri: { file(p: string): unknown };
};

test("activate registers the expected commands and starts the hub", async () => {
  const { activate, deactivate } = await import("../vscode/src/extension");
  const context = {
    subscriptions: [] as { dispose(): void }[],
    extension: { packageJSON: { version: "0.1.0" } },
    extensionUri: vscode.Uri.file(process.cwd()),
    asAbsolutePath: (p: string) => path.join(process.cwd(), p),
    globalState: { get: () => undefined, update: async () => {} },
  };
  await activate(context as never);

  for (const id of [
    "review-hub.setCheckpoint",
    "review-hub.acceptAll",
    "review-hub.rejectAll",
    "review-hub.acceptHunk",
    "review-hub.rejectHunk",
    "review-hub.openDiff",
    "review-hub.registerMcp",
    "review-hub.installInstructions",
  ]) {
    assert.ok(vscode.__commands.has(id), `command ${id} should be registered`);
  }

  // Host election runs in the background, so wait for hub.json to appear.
  const entryFile = path.join(home, ".review-hub", "hub.json");
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(entryFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(entryFile), "hub.json should exist after host election");
  const entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
  assert.ok(entry.url.startsWith("http://127.0.0.1:"));
  assert.equal(typeof entry.token, "string");

  assert.ok(vscode.__webviews.has("review-hub.changes"), "the sidebar panel view is registered");

  deactivate();
  for (const d of context.subscriptions) {
    d.dispose();
  }
  // The hub server closes asynchronously; give it time so the test process can exit.
  await new Promise((r) => setTimeout(r, 1500));
});
