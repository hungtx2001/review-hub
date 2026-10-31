import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";
import { buildStagedText } from "../vscode/src/ui/editor/staged-content";
import { STAGED_CONTEXT_KEY } from "../vscode/src/ui/editor/staged-review";

// The runner aliases `vscode` to test/vscode-stub.ts. This file activates the extension in
// its own process, so it gets a private hub and a private ~/.review-hub.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-wiring-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.REVIEW_HUB_DIR = path.join(home, ".review-hub");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-wiring-ws-"));
fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
process.env.VSCODE_STUB_CONFIG = JSON.stringify({ enabled: true, watchDirectWrites: false });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require("./vscode-stub") as {
  __listeners: { event: string }[];
  __commands: Map<string, unknown[]>;
  __executed: { command: string; args: unknown[] }[];
  __log: string[];
  Uri: { file(p: string): unknown };
};

/** Module-level so later tests in this file can dispose exactly what activation created. */
const ctx = {
  subscriptions: [] as { dispose(): void }[],
  extension: { packageJSON: { version: "0.3.1" } },
  extensionUri: vscode.Uri.file(process.cwd()),
  asAbsolutePath: (p: string) => path.join(process.cwd(), p),
  globalState: { get: () => undefined, update: async () => {} },
};

test("activation wires the staging engine into the workspace events", async () => {
  // Arm the engine before activation: a pending change whose buffer already holds the
  // merged view is exactly what hot-exit adoption takes over (spec D6b/F3), and a staged
  // file is what arms the save guard. The store is file-backed at the same baseDir the
  // extension uses, so activation sees this change.
  const store = new ChangeStore({});
  const cs = store.propose(ws, "a.txt", "one\ntwo\nthree\n");
  const aPath = path.join(ws, "a.txt");
  const diskText = fs.readFileSync(aPath, "utf8");
  const viewText = buildStagedText(cs);
  assert.ok(viewText, "the pending change has a staged view");
  assert.notEqual(viewText, diskText, "the merged view must differ from disk for this test to mean anything");
  const doc = {
    uri: { scheme: "file", fsPath: aPath },
    isDirty: false,
    lineCount: 1,
    lineAt: () => ({ range: {} }),
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    getText: () => viewText as string,
  };
  (vscode as unknown as { __textDocuments: unknown[] }).__textDocuments.push(doc);

  const { activate } = await import("../vscode/src/extension");
  await activate(ctx as never);

  const events = vscode.__listeners.map((l) => l.event);
  for (const event of ["change", "willSave", "open"]) {
    assert.ok(
      events.includes(event),
      `the staging engine must subscribe to "${event}", got [${events.join(", ")}]`,
    );
  }

  // F1: fire the guard with a save of the staged buffer. Stable VS Code cannot cancel the
  // save (C13), so the wrapper must hand it pre-save edits that restore the disk bytes —
  // the merged view must never be what reaches disk.
  const willSave = vscode.__listeners.find((l) => l.event === "willSave");
  let scheduled: unknown;
  willSave?.cb({
    document: doc,
    waitUntil: (p: unknown) => {
      scheduled = p;
    },
  });
  assert.ok(scheduled, "the save guard must schedule pre-save edits through waitUntil");
  const edits = (await scheduled) as { newText: string }[];
  assert.equal(edits.length, 1, "exactly one whole-document restore edit");
  assert.equal(
    edits[0].newText,
    diskText,
    "the pre-save edit restores the exact bytes on disk, so the save after it is a no-op (F1)",
  );
  assert.notEqual(edits[0].newText, viewText, "…and that is the disk text, not the merged view");

  // FINAL-2: closing a staged document must release its entry — Don't-Save-close then
  // reopen would otherwise leave isStaged true over a disk-content buffer and Tasks 3/4
  // would anchor the merged view's coordinates onto the wrong lines (F3: the document is
  // already gone — nothing to preserve, nothing to write).
  const close = vscode.__listeners.find((l) => l.event === "close");
  assert.ok(close, "the extension must subscribe to onDidCloseTextDocument");
  close.cb({ uri: { scheme: "file", fsPath: aPath } });
  assert.deepEqual(
    vscode.__executed.filter((e) => e.command === "setContext").at(-1)?.args,
    [STAGED_CONTEXT_KEY, false],
    "closing the staged document must release the entry and take the context key down",
  );

  // A stale entry would keep blocking plain on-disk saves; with the entry released that
  // save belongs to the user again.
  let scheduledAfterClose: unknown;
  willSave?.cb({
    document: { ...doc, getText: () => diskText },
    waitUntil: (p: unknown) => {
      scheduledAfterClose = p;
    },
  });
  assert.equal(
    scheduledAfterClose,
    undefined,
    "a closed file's plain save must not be blocked by a stale entry",
  );

  // Reopening re-stages the pending change through the engine's own open handler, so the
  // later tests in this file still see a staged, revertable buffer.
  vscode.__listeners.find((l) => l.event === "open")?.cb({ uri: { scheme: "file", fsPath: aPath } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    vscode.__executed.filter((e) => e.command === "setContext").at(-1)?.args,
    [STAGED_CONTEXT_KEY, true],
    "reopening the file must re-stage the pending change",
  );
});

// File-level teardown: activation's intervals and hub live in `ctx.subscriptions`, so
// disposing it here is what lets this test file's process exit (the brief only disposed
// from Task 7's test, which would leave this file hanging until then).
after(() => {
  for (const s of ctx.subscriptions.slice()) {
    try {
      s.dispose();
    } catch {
      // already disposed / non-disposable entry
    }
  }
  ctx.subscriptions.length = 0;
});

test("the staged Accept/Reject buttons are declared and registered", async () => {
  const pkg = JSON.parse(fs.readFileSync(fs.existsSync(path.join(__dirname, "..", "vscode", "package.json")) ? path.join(__dirname, "..", "vscode", "package.json") : path.join(__dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: { command: string; icon?: string }[]; menus: Record<string, { command: string; when?: string }[]> };
  };
  const { STAGED_CONTEXT_KEY } = await import("../vscode/src/ui/editor/staged-review");

  for (const id of ["review-hub.stagedAcceptAll", "review-hub.stagedRejectAll"]) {
    const declared = pkg.contributes.commands.find((c) => c.command === id);
    assert.ok(declared, `${id} must be declared`);
    assert.ok(declared.icon, `${id} needs an icon to render in the editor title`);
    assert.ok(vscode.__commands.has(id), `${id} must be registered by activate()`);
  }

  const titleMenu = pkg.contributes.menus["editor/title"] ?? [];
  const entries = titleMenu.filter((i) => i.command.endsWith("stagedAcceptAll") || i.command.endsWith("stagedRejectAll"));
  assert.equal(entries.length, 2, "both buttons live in editor/title");
  for (const entry of entries) {
    assert.ok(entry.when?.includes(STAGED_CONTEXT_KEY), `a button must be gated on ${STAGED_CONTEXT_KEY}`);
    assert.ok(entry.when?.includes("resourceScheme == file"));
  }
});

test("deactivate() runs the exit flush before the window goes away", async () => {
  const { deactivate } = await import("../vscode/src/extension");

  await deactivate();

  assert.ok(
    vscode.__log.some((line) => line.includes("exit flush")),
    `the flush must log its summary; log was: ${vscode.__log.join(" | ")}`,
  );

  // D6: the flush writes the resolved bytes, then every staged buffer must be handed back to
  // what is now on disk — a merged view that survives into the next session has no record left
  // to adopt it, so a routine save would write display text (F1). Engine entries only (F3).
  const reverted = vscode.__executed
    .filter((e) => e.command === "workbench.action.files.revert")
    .map((e) => (e.args[0] as { fsPath: string }).fsPath);
  const stagedPath = path.join(ws, "a.txt");
  assert.ok(
    reverted.includes(stagedPath),
    `deactivate() must revert the staged buffer before it resolves; reverted: [${reverted.join(", ")}]`,
  );
  assert.ok(
    reverted.every((p) => p === stagedPath),
    `only engine-staged buffers may be reverted (F3); reverted: [${reverted.join(", ")}]`,
  );

  // Release the hub the first test started so the process can exit. `ctx` is the module-level
  // context created in Task 5 — activation already pushed its subscriptions onto it.
  for (const d of ctx.subscriptions) {
    d.dispose();
  }
  await new Promise((r) => setTimeout(r, 1500));
});
