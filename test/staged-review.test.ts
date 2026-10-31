import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StagedReview,
  STAGED_CONTEXT_KEY,
  type StageNotice,
  type StagedDocument,
  type StagedHost,
} from "../vscode/src/ui/editor/staged-review";
import { buildStagedText } from "../vscode/src/ui/editor/staged-content";
import type { ChangeSet, Hunk } from "../core/src/types";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeDoc implements StagedDocument {
  readonly uri = { scheme: "file", fsPath: "" };
  isDirty = false;
  constructor(fsPath: string, private text: string) {
    this.uri.fsPath = fsPath;
  }
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
    this.isDirty = true;
  }
}

function hunk(id: string, oldStart: number, oldLine: string, newLine: string, decision: Hunk["decision"] = "pending"): Hunk {
  return { id, oldStart, oldLines: [oldLine], newStart: oldStart, newLines: [newLine], decision };
}

function makeChange(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "fs",
    applied: true,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "one\ntwo\nthree\n",
    proposed: "one\nTWO\nthree\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [hunk("h1", 1, "two", "TWO")],
    status: "applied",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Harness {
  staged: StagedReview;
  docs: FakeDoc[];
  contexts: [string, boolean][];
  notices: StageNotice[];
  reverts: string[];
  replaced(): number;
  stagedEvents(): number;
  fireTextChange(doc: FakeDoc): void;
  fireWillSave(fsPath: string, text?: string): boolean; // true when the save was prevented
  fireOpen(fsPath: string): void;
}

function harness(changes: ChangeSet[], opts: { autoSave?: string; docs?: FakeDoc[]; failReplace?: boolean } = {}): Harness {
  const docs = opts.docs ?? [];
  const contexts: [string, boolean][] = [];
  const notices: StageNotice[] = [];
  const reverts: string[] = [];
  let replaced = 0;
  let stagedEvents = 0;
  const changeCbs: ((d: StagedDocument) => void)[] = [];
  const saveCbs: ((p: string, prevent: () => void, text?: string) => void)[] = [];
  const openCbs: ((p: string) => void)[] = [];

  const host: StagedHost = {
    documents: () => docs,
    open: async (fsPath) => {
      const doc = docs.find((d) => d.uri.fsPath === fsPath);
      // VS Code fires onDidOpenTextDocument when a document enters the workspace, including
      // the open our own stage() performs — this is what exercises the re-entry guard.
      if (doc) {
        for (const cb of openCbs) cb(fsPath);
      }
      return doc;
    },
    replace: async (fsPath, text) => {
      replaced++; // counts calls, so a failed replace is still observable
      const doc = docs.find((d) => d.uri.fsPath === fsPath);
      if (!doc || opts.failReplace) {
        return false;
      }
      doc.setText(text);
      for (const cb of changeCbs) cb(doc); // fires synchronously, while `applying` is set
      return true;
    },
    revert: (fsPath) => reverts.push(fsPath),
    autoSave: () => opts.autoSave ?? "off",
    findById: (id) => changes.find((c) => c.id === id),
    changeForPath: (fsPath) => changes.find((c) => c.absPath === fsPath),
    onDidChangeTextDocument: (cb) => {
      changeCbs.push(cb);
      return { dispose() {} };
    },
    onWillSaveTextDocument: (cb) => {
      saveCbs.push(cb);
      return { dispose() {} };
    },
    onDidOpenTextDocument: (cb) => {
      openCbs.push(cb);
      return { dispose() {} };
    },
    setContext: (key, value) => contexts.push([key, value]),
    notice: (reason) => notices.push(reason),
    onStaged: () => {
      stagedEvents++;
    },
  };

  const staged = new StagedReview(host);
  staged.start();
  return {
    staged,
    docs,
    contexts,
    notices,
    reverts,
    replaced: () => replaced,
    stagedEvents: () => stagedEvents,
    fireTextChange: (doc) => changeCbs.forEach((cb) => cb(doc)),
    fireWillSave: (fsPath, text) => {
      let prevented = false;
      saveCbs.forEach((cb) => cb(fsPath, () => (prevented = true), text));
      return prevented;
    },
    fireOpen: (fsPath) => openCbs.forEach((cb) => cb(fsPath)),
  };
}

test("staging puts the merged view in the buffer and records the file", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed); // origin fs: the disk already has the new code
  const h = harness([cs], { docs: [doc] });

  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(doc.getText(), buildStagedText(cs), "the buffer now shows old + new");
  assert.equal(doc.isDirty, true, "the buffer is a view; the disk is untouched");
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(h.staged.changeIdFor("/ws/a.txt"), "c1");
  assert.deepEqual(h.contexts.at(-1), [STAGED_CONTEXT_KEY, true]);
  assert.equal(h.replaced(), 1);
});

test("staging the same change twice replaces the buffer once", async () => {
  const cs = makeChange();
  const h = harness([cs], { docs: [new FakeDoc("/ws/a.txt", cs.proposed)] });

  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(h.replaced(), 1, "the re-entrant open fired by our own open() must not restage");
});

test("a buffer the user already edited is never overwritten", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", "my own unsaved edits\n");
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc] });

  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(doc.getText(), "my own unsaved edits\n");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.equal(h.replaced(), 0);
});

test("auto-save turns staging off and reports it exactly once", async () => {
  const cs = makeChange();
  const h = harness([cs], { docs: [new FakeDoc("/ws/a.txt", cs.proposed)], autoSave: "afterDelay" });

  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.deepEqual(h.notices, ["auto-save"]);
});

test("the decision that closes the last hunk hands the buffer back to disk", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });
  await h.staged.stage("c1");

  cs.hunks = cs.hunks.map((x) => ({ ...x, decision: "accepted" }));
  assert.equal(await h.staged.restage("c1"), false, "nothing is pending any more");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.deepEqual(h.reverts, ["/ws/a.txt"], "the editor reloads the file settle() wrote");
});

test("restaging rebuilds the view for the hunks that are still pending", async () => {
  const cs = makeChange({
    baseline: "a\nb\nc\nd\n",
    proposed: "A\nb\nC\nd\n",
    hunks: [hunk("h1", 0, "a", "A"), hunk("h2", 2, "c", "C")],
  });
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const changes = [cs];
  const h = harness(changes, { docs: [doc] });
  await h.staged.stage("c1");
  assert.equal(doc.getText(), "a\nA\nb\nc\nC\nd\n");

  cs.hunks = cs.hunks.map((x) => (x.id === "h1" ? { ...x, decision: "accepted" } : x));
  assert.equal(await h.staged.restage("c1"), true, "h2 is still pending, so staging stays");
  assert.equal(doc.getText(), "A\nb\nc\nC\nd\n", "the accepted old block is gone from the view");
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);

  // The record is gone (agent reverted / checkpoint cleared): restage must release the
  // entry and reload disk, so reviewHub.hasStagedReview goes honest again.
  changes.length = 0;
  assert.equal(await h.staged.restage("c1"), false, "a change whose record vanished is not restaged");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the entry must not leak");
  assert.deepEqual(h.reverts, ["/ws/a.txt"], "the buffer only ever held our view, so reloading destroys nothing");
});

test("typing into a staged buffer lifts the staging and keeps the record pending", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });
  await h.staged.stage("c1");

  doc.setText("hand edit\n");
  h.fireTextChange(doc);

  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the user owns the buffer now");
  assert.equal(h.reverts.length, 0, "nothing of the user's is reverted (spec F3)");
  assert.deepEqual(h.contexts.at(-1), [STAGED_CONTEXT_KEY, false]);
});

test("an explicit save is refused while a hunk is still pending", async () => {
  const cs = makeChange();
  const changes = [cs];
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness(changes, { docs: [doc] });
  await h.staged.stage("c1");

  assert.equal(h.fireWillSave("/ws/a.txt"), true, "the interleaved view must not reach disk");
  assert.deepEqual(h.notices, ["save-blocked"]);
  assert.equal(h.fireWillSave("/ws/a.txt"), true, "still refused, but the user is told once");
  assert.deepEqual(h.notices, ["save-blocked"], "the warning is not repeated");

  // The record can vanish under us (removeChange when the agent reverts the file,
  // clearChanges on a new checkpoint): the guard must still fail CLOSED (spec F1).
  changes.length = 0;
  assert.equal(h.fireWillSave("/ws/a.txt"), true, "no record still means no interleaved bytes on disk");
  assert.deepEqual(h.notices, ["save-blocked"], "and the warning is still not repeated");

  // C21/FINAL-1: a neutralized save restores the disk bytes as a PRE-SAVE EDIT, so the
  // engine sees a text change and lifts staging — the entry is gone by then. Ctrl+Z puts
  // the view back into the buffer and the next plain save must STILL be refused: the
  // buffer text is exactly the view the engine wrote, entry or not (spec F1).
  const view = buildStagedText(cs)!;
  doc.setText(cs.proposed); // the pre-save edit restored the bytes on disk
  h.fireTextChange(doc); // …delivered as a text change → staging lifts
  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the neutralized save lifted staging");
  doc.setText(view); // Ctrl+Z: the undo restores the view
  assert.equal(h.fireWillSave("/ws/a.txt", view), true, "an undo-restored view must never reach disk (F1)");
  assert.equal(
    h.fireWillSave("/ws/a.txt", "hand edit\n"),
    false,
    "the user's own text is not ours to protect",
  );
  assert.deepEqual(h.notices, ["save-blocked"], "and the warning is still shown only once");
});

test("files that are not staged are never touched by the save guard", () => {
  const h = harness([makeChange()], { docs: [new FakeDoc("/ws/a.txt", "plain\n")] });
  assert.equal(h.fireWillSave("/ws/a.txt"), false);
  assert.deepEqual(h.notices, []);
});

test("a buffer hot exit restored is re-adopted when it still matches the view", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", buildStagedText(cs)!);
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc], failReplace: true });

  assert.equal(h.staged.adoptOpenDocuments(), 1);
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(h.replaced(), 0, "matching content needs no edit");

  // C22/FINAL-1: adoption established this buffer as the view, so even with the entry
  // released the guard must refuse a save whose text IS that view. Chain: a neutralized
  // save restores disk bytes as a pre-save edit → staging lifts → Ctrl+Z puts the view
  // back → plain save → refused (spec F1).
  const view = doc.getText();
  doc.setText(cs.proposed); // the pre-save edit restored the bytes on disk
  h.fireTextChange(doc); // …delivered as a text change → staging lifts
  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the neutralized save lifted staging");
  doc.setText(view); // Ctrl+Z: the undo restores the view
  assert.equal(h.fireWillSave("/ws/a.txt", view), true, "an undo-restored view must never reach disk (F1)");
  assert.equal(
    h.staged.adoptOpenDocuments(),
    1,
    "the view is back, so adoption can pick it up again for the rollback scenario below",
  );

  // A failed buffer write during restage must roll the entry back, mirroring stage():
  // the presentation layer must stop claiming it renders the view.
  assert.equal(await h.staged.restage("c1"), false, "a failed replace is not reported as still staged");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the entry is rolled back");
  assert.equal(h.replaced(), 1, "replace was called once — by the failed restage");
  assert.equal(h.reverts.length, 0, "the buffer is kept, not reverted — nothing of the user's is destroyed");
});

test("a buffer that does not match is left exactly as it is", () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", "my crash-time edits\n");
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc] });

  assert.equal(h.staged.adoptOpenDocuments(), 0);
  assert.equal(doc.getText(), "my crash-time edits\n");
  assert.equal(h.reverts.length, 0, "never reverted — that would destroy the user's work");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
});

test("opening a file that still has a pending change stages it", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });

  h.fireOpen("/ws/a.txt");
  await tick();
  await tick();

  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(doc.getText(), buildStagedText(cs));
});
