/**
 * Inline staged review: keep a change's review state IN the editor buffer.
 *
 * The buffer holds the merged view (old block above new block) while the file on disk keeps
 * exactly what it held before — for an "fs" change the agent's new code, for an "mcp" change
 * the baseline. Decisions never run through this module: `ChangeStore.accept/reject` still
 * writes the correctly resolved bytes, and this engine only re-stages the view afterwards
 * (spec F1). When the last hunk is decided the view is byte-identical to the file, so
 * `restage()` un-stages and reverts the editor (spec F2). The save guard refuses any save
 * whose buffer text equals the view the engine established — entry or not — so an undo of
 * a neutralized save can never put the view on disk (spec F1).
 *
 * Deliberately free of `vscode`: every host capability arrives through `StagedHost`, so the
 * state machine is unit-testable and `src/extension.ts` owns all VS Code calls.
 */
import { buildStagedText, pendingCount, stageSkipReason, type StageSkipReason } from "./staged-content";
import type { ChangeSet } from "../../../../core/src/types";

export type StageNotice = StageSkipReason | "save-blocked";

/** Context key the editor-title Accept/Reject buttons are gated on (`package.json`). */
export const STAGED_CONTEXT_KEY = "reviewHub.hasStagedReview";

/** The subset of `vscode.TextDocument` the engine needs. */
export interface StagedDocument {
  readonly uri: { scheme: string; fsPath: string };
  getText(): string;
  readonly isDirty: boolean;
}

export interface StagedHost {
  /** Every document currently open in the workspace. */
  documents(): StagedDocument[];
  /** Open the document for `fsPath` (never shows it). `undefined` when it cannot be opened. */
  open(fsPath: string): Promise<StagedDocument | undefined>;
  /** Replace the whole document text (a `WorkspaceEdit` in the real host). */
  replace(fsPath: string, text: string): Promise<boolean>;
  /** Discard the buffer and reload the file from disk. */
  revert(fsPath: string): void;
  /** The raw `files.autoSave` value. */
  autoSave(): string;
  findById(changeId: string): ChangeSet | undefined;
  changeForPath(fsPath: string): ChangeSet | undefined;
  onDidChangeTextDocument(cb: (doc: StagedDocument) => void): { dispose(): void };
  onWillSaveTextDocument(cb: (fsPath: string, prevent: () => void, text?: string) => void): { dispose(): void };
  onDidOpenTextDocument(cb: (fsPath: string) => void): { dispose(): void };
  /** Set the `when`-clause context key for the editor title buttons. */
  setContext(key: string, value: boolean): void;
  /** One-shot user-facing notice (auto-save guard, blocked save). */
  notice(reason: StageNotice, changeId?: string): void;
  /** Something changed about what is staged — re-render the presentation layer. */
  onStaged(): void;
}

interface Entry {
  changeId: string;
  /** True while our own `replace()` is in flight, so its change event is not mistaken for typing. */
  applying: boolean;
}

export class StagedReview {
  private readonly entries = new Map<string, Entry>();
  /**
   * The text this engine has established as each buffer's view (set in `stage()`/`restage()`
   * after a successful `replace()`, in `stage()`'s equal-content branch, and on adoption —
   * every path that establishes the view — and never cleared). An exact-text match can only
   * fire on a genuine view restore, i.e. undoing the pre-save restore of a neutralized save,
   * and the consequence of an over-broad entry is only ever a neutralizing save (byte-
   * identical disk restore) — the fail-safe direction (spec F1).
   */
  private readonly viewTexts = new Map<string, string>();
  /** Files with a `stage()` in flight — the re-entrancy guard for our own `open()`. */
  private readonly busy = new Set<string>();
  private readonly noticed = new Set<StageNotice>();
  private subs: { dispose(): void }[] = [];

  constructor(private readonly host: StagedHost) {}

  /** Register the three host listeners. Call once, after the rest of the UI exists. */
  start(): void {
    this.subs.push(
      this.host.onDidChangeTextDocument((doc) => this.handleTextChange(doc)),
      this.host.onWillSaveTextDocument((fsPath, prevent, text) => this.handleWillSave(fsPath, prevent, text)),
      this.host.onDidOpenTextDocument((fsPath) => {
        // A failed stage is never fatal: the file simply keeps the unstaged path.
        this.stageOnOpen(fsPath).catch(() => undefined);
      }),
    );
  }

  isStaged(fsPath: string): boolean {
    return this.entries.has(fsPath);
  }

  changeIdFor(fsPath: string): string | undefined {
    return this.entries.get(fsPath)?.changeId;
  }

  stagedCount(): number {
    return this.entries.size;
  }

  /**
   * Absolute paths whose buffer currently holds the merged view. The exit flush (spec D6)
   * reverts exactly these and nothing else — never a document the engine does not own (spec F3).
   */
  stagedPaths(): string[] {
    return [...this.entries.keys()];
  }

  /** Stage one change's file (spec D1). Returns true when the buffer shows the merged view. */
  async stage(changeId: string): Promise<boolean> {
    const cs = this.host.findById(changeId);
    if (!cs) {
      return false;
    }
    const held = this.entries.get(cs.absPath);
    if (held?.changeId === changeId) {
      return true;
    }
    const reason = stageSkipReason(cs, this.host.autoSave());
    if (reason) {
      this.noticeOnce(reason, changeId);
      return false;
    }
    if (this.busy.has(cs.absPath)) {
      return false;
    }
    const text = buildStagedText(cs);
    if (text === undefined) {
      return false;
    }
    this.busy.add(cs.absPath);
    try {
      const doc = await this.host.open(cs.absPath);
      if (!doc || doc.uri.scheme !== "file") {
        return false;
      }
      // The user's own unsaved edits always win (spec D1 guard).
      if (doc.isDirty && !held) {
        return false;
      }
      this.remember(cs.absPath, changeId);
      if (doc.getText() !== text) {
        const entry = this.entries.get(cs.absPath)!;
        entry.applying = true;
        try {
          const ok = await this.host.replace(cs.absPath, text);
          if (!ok) {
            this.entries.delete(cs.absPath);
            return false;
          }
          this.viewTexts.set(cs.absPath, text);
        } finally {
          entry.applying = false;
        }
      } else {
        // The buffer already holds the view: record it exactly as a `replace()` would, so
        // the undo-after-neutralized-save guard covers this path too (C22).
        this.viewTexts.set(cs.absPath, text);
      }
    } finally {
      this.busy.delete(cs.absPath);
    }
    this.syncContext();
    this.host.onStaged();
    return true;
  }

  /**
   * Re-render after a decision: rebuild the view, or hand the buffer back to disk when
   * nothing is pending any more (spec F1/F2). Returns whether the file is still staged.
   */
  async restage(changeId: string): Promise<boolean> {
    const cs = this.host.findById(changeId);
    const fsPath = cs?.absPath ?? this.pathOf(changeId);
    if (!fsPath) {
      return false;
    }
    const entry = this.entries.get(fsPath);
    if (!entry || entry.changeId !== changeId) {
      return false;
    }
    if (!cs) {
      // The record is gone (agent reverted the file, checkpoint cleared it). The buffer still
      // holds only our view — any user keystroke would already have lifted staging in
      // handleTextChange, and adoption requires an exact match — so reloading disk destroys
      // nothing and lets the context key go honest again.
      this.unstage(changeId, { revert: true });
      return false;
    }
    if (pendingCount(cs) === 0) {
      this.unstage(changeId, { revert: true });
      return false;
    }
    const text = buildStagedText(cs);
    if (text === undefined) {
      this.unstage(changeId);
      return false;
    }
    entry.applying = true;
    let ok = false;
    try {
      ok = await this.host.replace(fsPath, text);
    } finally {
      entry.applying = false;
    }
    if (!ok) {
      // The buffer write failed: stop claiming we render the view and let the unstaged
      // fallback take over (mirrors stage()'s rollback on a failed replace).
      this.unstage(changeId);
      return false;
    }
    this.viewTexts.set(fsPath, text);
    this.host.onStaged();
    return true;
  }

  /** Stop staging a change. `revert` reloads the editor from disk (only used when they match). */
  unstage(changeId: string, opts: { revert?: boolean } = {}): void {
    const fsPath = this.pathOf(changeId);
    if (fsPath) {
      this.entries.delete(fsPath);
      if (opts.revert) {
        this.host.revert(fsPath);
      }
    }
    this.syncContext();
    this.host.onStaged();
  }

  /**
   * Reconciliation after hot exit / crash (spec D6b): adopt every open buffer that still
   * holds the view we built for it, leave every other buffer alone (spec F3).
   */
  adoptOpenDocuments(): number {
    let adopted = 0;
    for (const doc of this.host.documents()) {
      if (doc.uri.scheme !== "file" || this.entries.has(doc.uri.fsPath)) {
        continue;
      }
      const cs = this.host.changeForPath(doc.uri.fsPath);
      if (!cs || stageSkipReason(cs, this.host.autoSave())) {
        continue;
      }
      const text = buildStagedText(cs);
      if (text !== undefined && doc.getText() === text) {
        this.remember(doc.uri.fsPath, cs.id);
        // The exact match proves this buffer holds the view — established by us in an
        // earlier session — so it enters the save guard's view-text check like the rest (C22).
        this.viewTexts.set(doc.uri.fsPath, text);
        adopted++;
      }
    }
    if (adopted > 0) {
      this.syncContext();
      this.host.onStaged();
    }
    return adopted;
  }

  dispose(): void {
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs = [];
    this.entries.clear();
  }

  private async stageOnOpen(fsPath: string): Promise<void> {
    if (this.entries.has(fsPath) || this.busy.has(fsPath)) {
      return;
    }
    const cs = this.host.changeForPath(fsPath);
    if (cs) {
      await this.stage(cs.id);
    }
  }

  private handleTextChange(doc: StagedDocument): void {
    if (doc.uri.scheme !== "file") {
      return;
    }
    const entry = this.entries.get(doc.uri.fsPath);
    if (!entry || entry.applying) {
      return;
    }
    const cs = this.host.findById(entry.changeId);
    const staged = cs ? buildStagedText(cs) : undefined;
    if (staged !== undefined && doc.getText() === staged) {
      return; // our own edit, delivered after `replace()` settled
    }
    // The user typed into the staged view (spec D7): lift the staging, keep the record.
    this.unstage(entry.changeId);
  }

  private handleWillSave(fsPath: string, prevent: () => void, text?: string): void {
    const entry = this.entries.get(fsPath);
    // A buffer whose text is exactly the view we established holds the view — which is
    // precisely what an undo of a neutralized save restores, entry or not (C21/FINAL-1).
    if (text !== undefined && text === this.viewTexts.get(fsPath)) {
      // Refuse this save: writing view text would put the interleaved old+new blocks on
      // disk while hunks are pending (spec F1) — the neutralized save lifts staging, so
      // `entry` may well be gone already.
      prevent();
      this.noticeOnce("save-blocked", entry?.changeId);
      return;
    }
    if (!entry) {
      return; // not staged and not our view: nothing to protect (nothing of ours can leak)
    }
    const cs = this.host.findById(entry.changeId);
    if (cs && pendingCount(cs) === 0) {
      // Nothing pending: the view is byte-identical to the file settle() wrote (the framing
      // rule in staged-content), so letting the save through is a no-op (spec F2).
      return;
    }
    // No record (the agent reverted the file / a checkpoint cleared the change) OR hunks still
    // pending: the buffer is a display view either way and must never reach disk (spec F1/F2).
    prevent();
    this.noticeOnce("save-blocked", entry.changeId);
  }

  private noticeOnce(reason: StageNotice, changeId?: string): void {
    if (this.noticed.has(reason)) {
      return;
    }
    this.noticed.add(reason);
    this.host.notice(reason, changeId);
  }

  private remember(fsPath: string, changeId: string): void {
    const applying = this.entries.get(fsPath)?.applying ?? false;
    this.entries.set(fsPath, { changeId, applying });
  }

  private pathOf(changeId: string): string | undefined {
    for (const [fsPath, entry] of this.entries) {
      if (entry.changeId === changeId) {
        return fsPath;
      }
    }
    return undefined;
  }

  private syncContext(): void {
    this.host.setContext(STAGED_CONTEXT_KEY, this.entries.size > 0);
  }
}
