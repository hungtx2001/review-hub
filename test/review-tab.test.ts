import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ReviewTab, type TabActions } from "../vscode/src/ui/webview/review-tab";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-tab-"));
}

interface FakePanel {
  title: string;
  webview: { html: string; __receive(msg: unknown): void };
  posted: unknown[];
}

function setup() {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  const calls: string[] = [];
  const actions: TabActions = {
    acceptHunk: (c, h) => calls.push(`acceptHunk:${c}:${h}`),
    rejectHunk: (c, h) => calls.push(`rejectHunk:${c}:${h}`),
    acceptFile: (c) => calls.push(`acceptFile:${c}`),
    rejectFile: (c) => calls.push(`rejectFile:${c}`),
  };
  const tab = new ReviewTab(vscode.Uri.file(process.cwd()), { change: (id) => store.findById(id) }, actions);
  return { tab, store, cs, calls, ws };
}

function panels(): FakePanel[] {
  return (vscode as unknown as { __panels: FakePanel[] }).__panels;
}

test("open creates one panel with the review assets and a nonce CSP", () => {
  const { tab, cs } = setup();
  const before = panels().length;
  tab.open(cs.id);
  assert.equal(panels().length, before + 1, "exactly one panel was created");
  const panel = panels()[panels().length - 1];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /nonce-/);
  assert.match(panel.webview.html, /review\.js/);
  assert.match(panel.webview.html, /review\.css/);
  assert.match(panel.title, /a\.txt/);
});

test("open twice reuses the existing panel instead of opening a second tab", () => {
  const { tab, cs } = setup();
  tab.open(cs.id);
  const after = panels().length;
  tab.open(cs.id);
  assert.equal(panels().length, after, "no second panel");
});

test("the first post carries the rendered review state", () => {
  const { tab, cs } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  const update = panel.posted.find((m) => (m as { type?: string }).type === "update") as
    | { state: { lines: { kind: string; text: string }[]; hunks: unknown[] } }
    | undefined;
  assert.ok(update, "an update message was posted");
  assert.deepEqual(update!.state.lines.map((l) => l.kind), ["context", "deleted", "added", "context"]);
  assert.equal(update!.state.hunks.length, 1);
});

test("webview commands are routed to the tab actions", () => {
  const { tab, cs, calls } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  panel.webview.__receive({ command: "acceptHunk", changeId: cs.id, hunkId: cs.hunks[0].id });
  panel.webview.__receive({ command: "rejectFile", changeId: cs.id });
  assert.deepEqual(calls, [`acceptHunk:${cs.id}:${cs.hunks[0].id}`, `rejectFile:${cs.id}`]);
});

test("refresh re-posts the state and updates the title with the progress", () => {
  const { tab, store, cs } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  store.accept(cs.id, [cs.hunks[0].id]);
  tab.refresh(cs.id);
  const updates = panel.posted.filter((m) => (m as { type?: string }).type === "update");
  assert.ok(updates.length >= 2, "a second update was posted");
  assert.match(panel.title, /✓/, "a fully decided file is ticked");
});

test("opening an unknown change shows a warning and creates no panel", () => {
  const { tab } = setup();
  const before = panels().length;
  tab.open("deadbeef");
  assert.equal(panels().length, before);
  const messages = (vscode as unknown as { __messages: string[] }).__messages;
  assert.ok(messages.some((m) => m.includes("no longer exists")));
});
