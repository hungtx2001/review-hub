import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadOpenEditors, type ReloadableDocument } from "../vscode/src/ui/editor/editor-sync";

function doc(fsPath: string, opts: { dirty?: boolean; scheme?: string } = {}): ReloadableDocument {
  return { uri: { scheme: opts.scheme ?? "file", fsPath }, isDirty: opts.dirty ?? false };
}

test("reloads the clean editor showing the file that was just written", () => {
  const reverted: string[] = [];
  const reloaded = reloadOpenEditors([doc("/ws/a.txt"), doc("/ws/b.txt")], "/ws/a.txt", (uri) => {
    reverted.push(uri.fsPath);
  });

  assert.equal(reloaded, 1, "exactly the matching editor is reloaded");
  assert.deepEqual(reverted, ["/ws/a.txt"]);
});

test("never reverts an editor with unsaved edits", () => {
  const reverted: string[] = [];
  const reloaded = reloadOpenEditors([doc("/ws/a.txt", { dirty: true })], "/ws/a.txt", (uri) => {
    reverted.push(uri.fsPath);
  });

  assert.equal(reloaded, 0, "a dirty buffer keeps its content");
  assert.deepEqual(reverted, [], "the revert command must not be issued");
});

test("ignores other files and virtual documents", () => {
  const reverted: string[] = [];
  const reloaded = reloadOpenEditors(
    [doc("/ws/other.txt"), doc("/ws/a.txt", { scheme: "review-hub" })],
    "/ws/a.txt",
    (uri) => {
      reverted.push(uri.fsPath);
    },
  );

  assert.equal(reloaded, 0);
  assert.deepEqual(reverted, []);
});
