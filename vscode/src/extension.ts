import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger";
import { HubServer } from "../../core/src/hub-server";
import { registry, pidAlive, defaultBaseDir, type HubEntry } from "../../core/src/registry";
import { ChangeContentProvider } from "./ui/editor/content-provider";
import { HunkCodeLensProvider, DiffView } from "./ui/editor/diff-view";
import { ReviewPanelProvider, type PanelActions } from "./ui/webview/review-panel";
import { ReviewTab } from "./ui/webview/review-tab";
import type { PanelSource } from "./ui/webview/review-panel-state";
import { WorkspaceWatcher } from "./watcher/workspace-watcher";
import { ChangeDecorator } from "./ui/editor/change-decorator";
import { ChangeFileDecorationProvider } from "./ui/editor/file-decorations";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDE_EXTENSIONS, type ChangeStore } from "../../core/src/change-store";
import { flushPendingReviews } from "../../core/src/exit-flush";
import { writeWindowState, clearWindowState, readWindowStates } from "../../core/src/window-registry";
import { reloadOpenEditors } from "./ui/editor/editor-sync";
import { StagedReview, type StageNotice, type StagedHost } from "./ui/editor/staged-review";
import { HUB_PROTOCOL, type ChangeSet, type FileNode } from "../../core/src/types";

interface Config {
  enabled: boolean;
  watchDirectWrites: boolean;
  maxFileSize: number;
  excludeGlobs: string[];
  ignoreWhitespace: boolean;
  maxSnapshotFiles: number;
  /** Automatically open the diff for a file the moment an agent changes it. */
  autoOpenDiff: boolean;
}

/**
 * What `deactivate()` needs. Set by `activate()` once the staged engine exists, cleared by
 * `deactivate()` so a second activation (tests) cannot flush twice. `deactivate()` is async
 * (VS Code awaits it) and awaits every staged-buffer revert, so it still runs to completion
 * before `context.subscriptions` teardown — the store is alive when the flush happens.
 */
let runtime:
  | {
      store: ChangeStore;
      workspaces: () => string[];
      log: (message: string) => void;
      staged: StagedReview;
    }
  | undefined;

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration("review-hub");
  const userExcludes = c.get<string[]>("excludeGlobs", []);
  // User excludes are additive; the built-in defaults (VCS, deps, ML artifacts) always apply.
  const merged = Array.from(new Set([...DEFAULT_EXCLUDES, ...userExcludes]));
  return {
    enabled: c.get("enabled", true),
    watchDirectWrites: c.get("watchDirectWrites", true),
    maxFileSize: c.get("maxFileSize", 2 * 1024 * 1024),
    excludeGlobs: merged,
    ignoreWhitespace: c.get("ignoreWhitespace", false),
    maxSnapshotFiles: c.get("maxSnapshotFiles", 5000),
    autoOpenDiff: c.get("autoOpenDiff", false),
  };
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = readConfig();
  if (!config.enabled) {
    return;
  }
  const logger = new Logger("Review Hub");
  const baseDir = defaultBaseDir();

  const hub = new HubServer({
    baseDir,
    maxFileSize: config.maxFileSize,
    excludeGlobs: config.excludeGlobs,
    // Declared before the UI exists; the closures below are wired once it does.
    onChanged: (workspace, relPath) => hubChanged?.(workspace, relPath),
    onResolved: () => hubResolved?.(),
    // The MCP server routes a tool call by matching the agent's path against these, so a
    // harness whose working directory is not the project being edited still lands in the
    // right workspace.
    liveWorkspaces: () => workspaceFolders(),
    windowStates: () => readWindowStates(baseDir),
  });
  let hubChanged: ((workspace: string, relPath: string) => void) | undefined;
  let hubResolved: (() => void) | undefined;

  // ---- Host election (non-blocking) ----------------------------------------
  // One shared hub serves every VS Code window and every project. The first window to
  // acquire the registry lock becomes the host; later windows become clients that use
  // the same file-backed store and never start a second hub or rewrite hub.json.
  //
  // This runs in the BACKGROUND. `withLock` can wait up to 20s for another window, and
  // awaiting it here would stall activation — which is what made opening several windows
  // at once feel like the UI was hanging and jumping around.
  let isHost = false;
  let hubEntry: HubEntry | undefined;
  let disposed = false;

  const electHost = async (): Promise<void> => {
    try {
      await registry.withLock(async () => {
        // The window may have closed while we waited for the lock; starting a hub then
        // would leave an orphan server with no window to own it.
        if (disposed) {
          return;
        }
        const existing = registry.readEntry();
        if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
          isHost = false;
          return;
        }
        const addr = await hub.start(0);
        if (disposed) {
          await hub.stop();
          return;
        }
        hubEntry = {
          url: addr.url,
          token: addr.token,
          pid: process.pid,
          workspace: workspaceFolders()[0] ?? process.cwd(),
          updatedAt: Date.now(),
          protocol: HUB_PROTOCOL,
        };
        registry.writeEntry(hubEntry);
        isHost = true;
      });
      if (!disposed) {
        logger.info(isHost ? `hosting the shared hub at ${hubEntry?.url}` : "client mode: using the shared hub");
      }
    } catch (err) {
      logger.error(`host election failed: ${String(err)}`);
      if (!disposed) {
        void vscode.window.showErrorMessage("Review Hub: failed to start the local hub server.");
      }
    }
  };
  void electHost();

  // Keep hub.json alive while we host it: if it is deleted while we run (a cleanup, a
  // stale-lock sweep, another tool), rewrite it so the MCP server can still find us.
  // Starts immediately but no-ops until the background election decides we are the host.
  const republish = () => {
    if (!isHost || !hubEntry) {
      return;
    }
    const entry = hubEntry;
    try {
      const current = registry.readEntry();
      if (current && current.pid === process.pid && current.token === entry.token) {
        return;
      }
      if (current && current.pid !== process.pid && pidAlive(current.pid)) {
        return;
      }
      entry.updatedAt = Date.now();
      registry.writeEntry(entry);
      logger.info("re-published hub registry (hub.json was missing or stale)");
    } catch {
      // best effort
    }
  };
  const republishTimer = setInterval(republish, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(republishTimer) });

  // ---- Inline staged review (spec D1) --------------------------------------
  // `staged` is assigned after `openReviewTab` exists, exactly like the forward declaration
  // below: the CodeLens provider and the decorator only read it through the closures passed
  // to their constructors, and nothing renders before activation has finished.
  let staged: StagedReview;

  const changeForPath = (fsPath: string): ChangeSet | undefined => {
    for (const ws of workspaceFolders()) {
      const root = ws.replace(/[\\/]+$/, "");
      if (!fsPath.startsWith(root + "/") && !fsPath.startsWith(root + "\\")) {
        continue;
      }
      const rel = fsPath.slice(root.length + 1).split("\\").join("/");
      const cs = hub.store.findChangeByPath(root, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  };

  const autoSaveNoticeMuted = context.globalState.get<boolean>("review-hub.autoSaveNoticeShown") === true;

  const notice = (reason: StageNotice, changeId?: string): void => {
    if (reason === "save-blocked") {
      void vscode.window.showInformationMessage(
        "Review Hub: the staged view was cleared — the buffer now shows the file's on-disk content. Pending changes stay in Review Hub; reopen the file to continue reviewing.",
      );
      return;
    }
    if (autoSaveNoticeMuted || reason !== "auto-save") {
      return;
    }
    void vscode.window
      .showInformationMessage(
        "Review Hub: files.autoSave is on, so inline staged review is off — changes appear as highlights instead.",
        "Turn off auto-save",
        "Open the review tab",
        "Don't show again",
      )
      .then((choice) => {
        if (choice === "Turn off auto-save") {
          void vscode.workspace
            .getConfiguration("files")
            .update("autoSave", "off", vscode.ConfigurationTarget.Global);
        } else if (choice === "Open the review tab" && changeId) {
          openReviewTab(changeId);
        } else if (choice === "Don't show again") {
          void context.globalState.update("review-hub.autoSaveNoticeShown", true);
        }
      });
  };

  const stagedHost: StagedHost = {
    documents: () => [...vscode.workspace.textDocuments],
    open: async (fsPath) => {
      try {
        return await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      } catch {
        return undefined; // deleted on disk, unreadable, … — the unstaged path covers it
      }
    },
    replace: async (fsPath, text) => {
      try {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
        if (!doc) {
          return false;
        }
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, full, text);
        return await vscode.workspace.applyEdit(edit);
      } catch {
        return false;
      }
    },
    revert: (fsPath) =>
      void vscode.commands.executeCommand("workbench.action.files.revert", vscode.Uri.file(fsPath)),
    autoSave: () => vscode.workspace.getConfiguration("files").get("autoSave", "off"),
    findById: (changeId) => hub.store.findById(changeId),
    changeForPath,
    onDidChangeTextDocument: (cb) => vscode.workspace.onDidChangeTextDocument((e) => cb(e.document)),
    onWillSaveTextDocument: (cb) =>
      vscode.workspace.onWillSaveTextDocument((e) => {
        const doc = e.document;
        cb(
          doc.uri.fsPath,
          () => {
            // Stable VS Code offers no way to cancel a save (`TextDocumentWillSaveEvent`
            // has only `document`, `reason`, `waitUntil`), so we neutralize it instead of
            // refusing it: hand the editor pre-save edits that restore the exact bytes on
            // disk, so whatever follows is byte-identical to disk and the staged view can
            // never be what lands there (spec F1/F2 outcome).
            const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            e.waitUntil(
              (async () => {
                try {
                  return [vscode.TextEdit.replace(full, fs.readFileSync(doc.uri.fsPath, "utf8"))];
                } catch {
                  return []; // file gone/unreadable: no cancel exists, do not guess
                }
              })(),
            );
          },
          doc.getText(), // the buffer's text: lets the engine see an undo-restored view (C21)
        );
      }),
    onDidOpenTextDocument: (cb) =>
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === "file") {
          cb(doc.uri.fsPath);
        }
      }),
    setContext: (key, value) => void vscode.commands.executeCommand("setContext", key, value),
    notice,
    onStaged: () => {
      codeLens.refresh();
      refreshUi();
    },
  };

  /**
   * The staging trigger for a file that just changed: the watcher callback and
   * `hubChanged` (the MCP propose path) land here. If this exact change is already staged
   * we re-render instead of staging again — `stage()` short-circuits on an unchanged id,
   * `restage()` rebuilds the view.
   *
   * A decision made in another window is not re-staged here: the 2 s poll picks such a
   * change up only to refresh the UI, never to rebuild the buffer (accepted C3 limitation).
   */
  // Stage the merged review view for a file that just changed — but only for projects this
  // window actually has open: the hub is shared, so hubChanged can report any workspace.
  const stagePath = (ws: string, relPath: string): void => {
    if (!workspaceFolders().includes(ws)) {
      return;
    }
    const cs = hub.store.findChangeByPath(ws, relPath);
    if (!cs) {
      return;
    }
    const run =
      staged.changeIdFor(cs.absPath) === cs.id ? staged.restage(cs.id) : staged.stage(cs.id);
    run.catch((err) => logger.warn(`stage ${cs.path} failed: ${String(err)}`));
  };

  const provider = new ChangeContentProvider(hub.store);
  const codeLens = new HunkCodeLensProvider(hub.store, (fsPath) => staged.isStaged(fsPath));
  const decorator = new ChangeDecorator(hub.store, (fsPath) => staged.isStaged(fsPath));
  // A badge on every changed file in the Explorer, so the user sees what needs review
  // without opening a diff.
  const fileDecorations = new ChangeFileDecorationProvider(hub.store, workspaceFolders);

  // Only this window's own folders. The store is shared across windows, but a window must
  // show only the project the user has open here — not changes from other windows.
  const source: PanelSource = {
    workspaces: () => workspaceFolders(),
    checkpoint: (ws) => hub.store.checkpointInfo(ws),
    changeSets: (ws) => hub.store.listChangeSets(ws),
  };

  // `openReviewTab` is assigned below (after `tab` exists) but the action closures and the
  // auto-open flush reference it earlier, so it needs a forward declaration. Nothing else
  // does: `decide` is a `const` and `decideMany`/`decideFileById` are hoisted `async function`
  // declarations later in this scope, and a closure may reference a later `const` as long as
  // it does not *run* before that const is initialised.
  let openReviewTab: (changeId: string, targetHunkId?: string) => void;

  const panelActions: PanelActions = {
    acceptHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "accept"),
    rejectHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "reject"),
    acceptFile: (changeId) => void decideFileById(changeId, "accept"),
    rejectFile: (changeId) => void decideFileById(changeId, "reject"),
    acceptAll: () => void decideMany(workspaceFolders(), "accept"),
    rejectAll: () => void decideMany(workspaceFolders(), "reject"),
    openHunk: (changeId, hunkId) => openReviewTab(changeId, hunkId),
    openDiff: (changeId) => openReviewTab(changeId),
    setCheckpoint: () => void vscode.commands.executeCommand("review-hub.setCheckpoint"),
  };
  const panel = new ReviewPanelProvider(context.extensionUri, source, panelActions);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewType, panel),
  );

  const tab = new ReviewTab(
    context.extensionUri,
    { change: (changeId) => hub.store.findById(changeId) },
    {
      acceptHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "accept"),
      rejectHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "reject"),
      acceptFile: (changeId) => void decideFileById(changeId, "accept"),
      rejectFile: (changeId) => void decideFileById(changeId, "reject"),
    },
  );
  openReviewTab = (changeId, targetHunkId) => tab.open(changeId, targetHunkId);
  staged = new StagedReview(stagedHost);

  const diffView = new DiffView(hub.store, provider, codeLens, () => {
    refreshUi();
  });
  decorator.start();
  staged.start();
  runtime = {
    store: hub.store,
    workspaces: workspaceFolders,
    log: (message) => logger.info(message),
    staged,
  };

  /**
   * One place to refresh everything that reflects change state: the sidebar panel, the
   * review tab, the inline decorations on real files, the Explorer badges, and the status
   * bar. Called from the watcher, the hub events, every decision, and the commands.
   */
  function refreshUi(): void {
    panel.refresh();
    tab.refreshAll();
    decorator.refreshAll();
    fileDecorations.refresh();
    updateStatus();
  }

  // Like Antigravity: when an agent changes a file, open the MERGED review view beside the
  // editor — one document showing the old lines (red) above the new lines (green) with
  // per-hunk Accept/Reject. A plain highlight on the real file could only show the new
  // lines (VS Code injected text is single-line), so the old code would be invisible.
  const autoOpened = new Set<string>();
  const pendingAutoOpen = new Map<string, { workspace: string; path: string }>();
  let autoOpenTimer: NodeJS.Timeout | undefined;
  const scheduleAutoOpen = (workspace: string, relPath: string) => {
    if (!config.autoOpenDiff) {
      return;
    }
    // Never touch the UI for a change outside this window's own folders: opening a file
    // from another project would yank focus and clutter this window's editor.
    if (!workspaceFolders().includes(workspace)) {
      return;
    }
    pendingAutoOpen.set(`${workspace}\u0000${relPath}`, { workspace, path: relPath });
    if (autoOpenTimer) {
      clearTimeout(autoOpenTimer);
    }
    autoOpenTimer = setTimeout(() => {
      autoOpenTimer = undefined;
      void flushAutoOpen();
    }, 600);
  };
  const flushAutoOpen = async () => {
    const queued = Array.from(pendingAutoOpen.values());
    pendingAutoOpen.clear();
    for (const { workspace, path: relPath } of queued) {
      if (!workspaceFolders().includes(workspace)) {
        continue;
      }
      const cs = hub.store.findChangeByPath(workspace, relPath);
      if (!cs || cs.binary || cs.hunks.length === 0) {
        continue;
      }
      if (autoOpened.has(cs.id)) {
        continue;
      }
      // A staged file is already being reviewed in place — the review tab would be the
      // second surface for the same change (spec D8).
      if (staged.isStaged(cs.absPath)) {
        continue;
      }
      autoOpened.add(cs.id);
      try {
        // Open the review tab beside the editor, without stealing focus.
        openReviewTab(cs.id);
      } catch {
        // file may have been deleted; ignore
      }
      refreshUi();
    }
  };

  const watcher = new WorkspaceWatcher(
    hub.store,
    workspaceFolders,
    config.excludeGlobs,
    (ws, relPath) => {
      refreshUi();
      scheduleAutoOpen(ws, relPath);
      stagePath(ws, relPath);
    },
    DEFAULT_INCLUDE_EXTENSIONS,
  );
  if (config.watchDirectWrites) {
    watcher.start();
  }

  // Route hub events (the MCP path) into the same UI refresh + auto-open as the watcher.
  hubChanged = (workspace, relPath) => {
    refreshUi();
    if (relPath) {
      scheduleAutoOpen(workspace, relPath);
      stagePath(workspace, relPath);
    }
  };
  hubResolved = () => {
    refreshUi();
  };

  // The store is file-backed and shared across windows. A window that is not the hub
  // host gets no hub events, and even the host does not see edits another window's
  // agent made through the shared store. Poll cheaply so every window stays in sync:
  // the store's own cache revalidates by directory mtime, so this is a few stats.
  let seenChangeIds = new Set<string>();
  let primed = false;
  const pollTimer = setInterval(() => {
    try {
      const before = seenChangeIds;
      const now = new Set<string>();
      let changed = false;
      for (const ws of source.workspaces()) {
        for (const s of hub.store.listChanges(ws)) {
          now.add(s.id);
          if (!before.has(s.id)) {
            changed = true;
            // On the very first tick, adopt whatever is already on disk as "seen"
            // without opening anything: those changes existed before this window
            // opened, and auto-opening them would yank focus in a burst (the UI
            // "jumping around" on startup). Only changes that arrive after priming
            // are auto-opened.
            if (primed) {
              scheduleAutoOpen(ws, s.path);
            }
          }
        }
      }
      // Also detect removals (a change resolved in another window).
      if (primed && now.size !== before.size) {
        changed = true;
      }
      seenChangeIds = now;
      if (changed && primed) {
        refreshUi();
      }
      primed = true;
    } catch {
      // best effort
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  // Resolved change sets are kept briefly so an open review tab can render its final
  // state; sweep the stale ones so they do not accumulate on disk.
  const pruneTimer = setInterval(() => {
    try {
      hub.store.pruneResolved();
    } catch {
      // best effort
    }
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(pruneTimer) });

  // ---- Cross-window routing state ------------------------------------------
  // Publish this window's folders and active file so the shared hub can route an agent's
  // relative path to the project the user is actually working in — even when the agent's
  // harness was launched from a different directory.
  let focusedAt = Date.now();
  const publishWindowState = () => {
    writeWindowState(baseDir, {
      pid: process.pid,
      folders: workspaceFolders(),
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
      focusedAt,
      updatedAt: Date.now(),
    });
  };
  publishWindowState();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => publishWindowState()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => publishWindowState()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        focusedAt = Date.now();
        publishWindowState();
      }
    }),
    { dispose: () => clearWindowState(baseDir, process.pid) },
  );

  // Status bar.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "review-hub.openChanges";
  const updateStatus = () => {
    const total = source.workspaces().reduce((n, ws) => n + hub.store.listChanges(ws).length, 0);
    if (total === 0) {
      status.hide();
      return;
    }
    status.text = `$(diff) Review Hub: ${total} file${total === 1 ? "" : "s"}`;
    status.tooltip = "Click to review AI-made changes";
    status.show();
  };
  updateStatus();

  // Per-session model: NO workspace walk on activation. A file's baseline comes from
  // git HEAD (free) or is captured lazily the moment the agent proposes a change, so
  // opening a project costs nothing and a session with no changes shows nothing.
  refreshUi();
  // Hot exit can restore buffers we staged last session: adopt the ones that still hold the
  // view, leave every other buffer alone (spec D6b/F3).
  staged.adoptOpenDocuments();

  /**
   * Turn a command argument into a change id. Accepts an id, a plain `{ workspace, path }`
   * node (from a webview command or a menu), or a `Uri` from the Explorer.
   */
  const resolveChange = async (arg: FileNode | vscode.Uri | string | undefined): Promise<string | undefined> => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg && typeof arg === "object" && "fsPath" in arg) {
      for (const ws of workspaceFolders()) {
        const root = ws.replace(/[\\/]+$/, "");
        const fsPath = (arg as vscode.Uri).fsPath;
        if (!fsPath.startsWith(root + "/") && !fsPath.startsWith(root + "\\")) {
          continue;
        }
        const rel = fsPath.slice(root.length + 1).split("\\").join("/");
        const cs = hub.store.findChangeByPath(root, rel);
        if (cs) {
          return cs.id;
        }
      }
      return undefined;
    }
    if (arg && typeof arg === "object" && "path" in arg && "workspace" in arg) {
      return hub.store.findChangeByPath(arg.workspace, arg.path)?.id;
    }
    // Fall back to the active diff tab.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri } | undefined;
        if (input?.modified?.scheme === "review-hub") {
          return input.modified.path.replace(/^\//, "");
        }
      }
    }
    return undefined;
  };

  /**
   * Apply one Accept/Reject click. Never leaves the UI without a response: the decision
   * itself is a synchronous disk write, and any failure is surfaced as an error message
   * rather than being swallowed by the command runner. A guard stops a double-click (or a
   * click on a stale CodeLens) from stacking overlapping refreshes.
   */
  const deciding = new Set<string>();
  const decide = async (changeId: string, hunkIds: string[] | undefined, kind: "accept" | "reject") => {
    const cs = hub.store.findById(changeId);
    if (!cs) {
      // The change was resolved in another window, pruned, or the CodeLens is stale.
      void vscode.window.showInformationMessage("Review Hub: this change is no longer pending — refreshing.");
      refreshUi();
      return;
    }
    const key = `${changeId}\u0000${hunkIds?.join(",") ?? "*"}`;
    if (deciding.has(key)) {
      return;
    }
    deciding.add(key);
    try {
      // Diagnostic: a click that changes nothing means the id it carried was not in the
      // set (a stale lens) or the hunk was already decided. Log both so a "button does
      // nothing" report can be traced from the Output channel alone.
      const prior = (hunkIds ?? []).map((id) => {
        const h = cs.hunks.find((x) => x.id === id);
        return `${id}=${h ? h.decision : "NOT_FOUND"}`;
      });
      logger.info(
        `${kind} click ${changeId}: hunkIds=[${prior.join(", ")}] total=${cs.hunks.length} pendingBefore=${cs.hunks.filter((h) => h.decision === "pending").length}`,
      );
      const result = kind === "accept" ? hub.store.accept(changeId, hunkIds) : hub.store.reject(changeId, hunkIds);
      // Every decision may write the file — accepting materialises lines, and rejecting a
      // previously accepted hunk removes them again — so always suppress the watcher echo
      // for the file we just wrote. Gating this on `cs.applied` missed the partial-accept
      // case and let the watcher re-observe and clobber the staged change.
      watcher.noteSelfWrite(cs.absPath);
      // The decision just rewrote the file (atomic tmp+rename). Reload any editor that
      // is showing it, so the click visibly changes the buffer instead of racing the
      // file watcher. Dirty buffers are left alone — see reloadOpenEditors.
      // If the buffer is staged, staged.restage() smoothly updates it via applyEdit (no flicker).
      // Only unstaged buffers need a revert reload from disk.
      const isStaged = staged.changeIdFor(cs.absPath) === cs.id;
      let reloaded = 0;
      if (!isStaged) {
        reloaded = reloadOpenEditors(
          vscode.workspace.textDocuments,
          vscode.Uri.file(cs.absPath).fsPath,
          (uri) => void vscode.commands.executeCommand("workbench.action.files.revert", uri),
        );
      }
      // The buffer is only a view: re-render it from the decisions just recorded. When the
      // last hunk is decided this hands the buffer back to disk (spec F1/F2).
      await staged.restage(changeId);
      // diffView.refresh already triggers codeLens, diff provider, and refreshUi() once cleanly.
      await diffView.refresh(changeId);
      logger.info(
        `${kind} ${changeId} -> ${result.status} (remaining ${result.remaining}, editors reloaded=${reloaded})`,
      );
    } catch (err) {
      logger.error(`${kind} ${changeId} failed: ${String(err)}`);
      void vscode.window.showErrorMessage(
        `Review Hub: could not ${kind} the change in ${cs.path} — ${err instanceof Error ? err.message : String(err)}`,
      );
      // Still refresh: a partial write may have landed, and the UI must not stay stale.
      refreshUi();
    } finally {
      deciding.delete(key);
    }
  };

  context.subscriptions.push(
    status,
    provider,
    watcher,
    diffView,
    tab,
    fileDecorations,
    vscode.workspace.registerTextDocumentContentProvider("review-hub", provider),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.languages.registerCodeLensProvider({ scheme: "review-hub" }, codeLens),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLens),
    decorator,
    staged,
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const id = staged.changeIdFor(doc.uri.fsPath);
      if (id) {
        // The document is already gone: release the staging entry WITHOUT reverting
        // (spec F3 — nothing to preserve, nothing to write). Reopening re-stages from disk.
        staged.unstage(id);
      }
    }),

    vscode.commands.registerCommand("review-hub.refresh", () => {
      refreshUi();
    }),
    vscode.commands.registerCommand("review-hub.openChanges", () =>
      vscode.commands.executeCommand("review-hub.changes.focus"),
    ),
    vscode.commands.registerCommand("review-hub.openDiff", async (arg?: FileNode | vscode.Uri | string) => {
      const changeId = await resolveChange(arg);
      if (changeId) {
        tab.open(changeId);
      }
    }),
    // Open the classic side-by-side (baseline | proposed) diff instead of the merged view.
    vscode.commands.registerCommand("review-hub.openSideBySide", async (arg?: FileNode | vscode.Uri | string) => {
      const changeId = await resolveChange(arg);
      if (changeId) {
        await diffView.openSideBySide(changeId);
      }
    }),
    // Open the real file on disk (the new content), for editing in place.
    vscode.commands.registerCommand("review-hub.openFile", async (arg?: FileNode | vscode.Uri | string) => {
      const changeId = await resolveChange(arg);
      const cs = changeId ? hub.store.findById(changeId) : undefined;
      if (cs) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(cs.absPath));
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      }
    }),
    vscode.commands.registerCommand("review-hub.acceptHunk", (changeId: string, hunkId: string) =>
      decide(changeId, [hunkId], "accept"),
    ),
    vscode.commands.registerCommand("review-hub.rejectHunk", (changeId: string, hunkId: string) =>
      decide(changeId, [hunkId], "reject"),
    ),
    // Editor-title buttons (spec D3): every hunk of the file being reviewed in place.
    vscode.commands.registerCommand("review-hub.stagedAcceptAll", () => decideActiveStaged("accept")),
    vscode.commands.registerCommand("review-hub.stagedRejectAll", () => decideActiveStaged("reject")),
    vscode.commands.registerCommand("review-hub.acceptFile", (arg?: FileNode) => decideFile(arg, "accept")),
    vscode.commands.registerCommand("review-hub.rejectFile", (arg?: FileNode) => decideFile(arg, "reject")),
    vscode.commands.registerCommand("review-hub.undoFile", (arg?: FileNode) => decideFile(arg, "reject")),

    // Resolve every change in every project this window knows about.
    vscode.commands.registerCommand("review-hub.acceptAll", async () => {
      await decideMany(source.workspaces(), "accept");
    }),
    vscode.commands.registerCommand("review-hub.rejectAll", async () => {
      await decideMany(source.workspaces(), "reject");
    }),
    vscode.commands.registerCommand("review-hub.setCheckpoint", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Review Hub: setting checkpoint…", cancellable: false },
        async () => {
          for (const ws of workspaceFolders()) {
            await hub.store.setCheckpoint(ws, {
              maxFileSize: config.maxFileSize,
              excludeGlobs: config.excludeGlobs,
              includeExtensions: DEFAULT_INCLUDE_EXTENSIONS,
              maxFiles: config.maxSnapshotFiles,
              maxDurationMs: 30_000,
            });
          }
        },
      );
      refreshUi();
      void vscode.window.showInformationMessage("Review Hub: checkpoint set — changes are measured from now.");
    }),
    vscode.commands.registerCommand("review-hub.clearCheckpoint", async () => {
      const pick = await vscode.window.showWarningMessage(
        "Clear the checkpoint? Future changes will have no baseline until you set a new one.",
        { modal: true },
        "Clear",
      );
      if (pick !== "Clear") {
        return;
      }
      for (const ws of workspaceFolders()) {
        hub.store.clearCheckpoint(ws);
      }
      refreshUi();
    }),
    vscode.commands.registerCommand("review-hub.copyMcpConfig", () => copyMcpConfigSnippet()),
    vscode.commands.registerCommand("review-hub.copyAgentRules", () => copyAgentRulesSnippet()),
    vscode.commands.registerCommand("review-hub.openWebsite", () => {
      void vscode.env.openExternal(vscode.Uri.parse("https://hungtx2001.github.io/review-hub/"));
    }),
    vscode.commands.registerCommand("review-hub.registerMcp", () => copyMcpConfigSnippet()),
    vscode.commands.registerCommand("review-hub.installInstructions", () => installInstructions()),
    vscode.commands.registerCommand("review-hub.showHubInfo", async () => {
      const entry = registry.readEntry();
      const msg = entry
        ? `Hub: ${entry.url}\nPID: ${entry.pid} (alive: ${pidAlive(entry.pid)})\nWorkspace: ${entry.workspace}\nMCP server: npx -y review-hub-mcp`
        : "No hub registry entry.";
      void vscode.window.showInformationMessage(msg, { modal: true });
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (async () => {
        for (const ws of workspaceFolders()) {
          try {
            await hub.store.ensureCheckpoint(ws, {
              maxFileSize: config.maxFileSize,
              excludeGlobs: config.excludeGlobs,
              includeExtensions: DEFAULT_INCLUDE_EXTENSIONS,
              maxFiles: config.maxSnapshotFiles,
              maxScanned: 50_000,
              maxDurationMs: 15_000,
            });
          } catch (err) {
            logger.warn(`checkpoint for ${ws} failed: ${String(err)}`);
          }
        }
        refreshUi();
      })();
    }),

    // Only the host owns the hub and its registry entry. A client must not stop the
    // shared hub or clear hub.json, or the still-running host would become unreachable.
    // `isHost` is decided by the background election, so check it at dispose time.
    {
      dispose: () => {
        disposed = true;
        if (!isHost) {
          return;
        }
        void hub.stop();
        // Only clear the entry if it is still ours; another window may have taken over.
        const current = registry.readEntry();
        if (current && current.pid === process.pid) {
          registry.clearEntry();
        }
      },
    },
    logger,
  );

  const decideActiveStaged = async (kind: "accept" | "reject"): Promise<void> => {
    const active = vscode.window.activeTextEditor;
    const changeId = active ? staged.changeIdFor(active.document.uri.fsPath) : undefined;
    if (!changeId) {
      void vscode.window.showInformationMessage("Review Hub: no staged review in this file.");
      return;
    }
    await decide(changeId, undefined, kind);
  };

  async function decideFileById(changeId: string, kind: "accept" | "reject") {
    await decide(changeId, undefined, kind);
  }

  async function decideFile(arg: FileNode | undefined, kind: "accept" | "reject") {
    const changeId = await resolveChange(arg);
    if (changeId) {
      await decideFileById(changeId, kind);
    }
  }

  /** Resolve every change across the given workspaces. */
  async function decideMany(workspaces: string[], kind: "accept" | "reject"): Promise<void> {
    const total = workspaces.reduce((n, ws) => n + hub.store.listChangeSets(ws).length, 0);
    if (total === 0) {
      void vscode.window.showInformationMessage("Review Hub: nothing to review.");
      return;
    }
    // Confirming avoids a stray click silently accepting (or discarding) a lot of work.
    const label = kind === "accept" ? "Accept" : "Reject";
    const where = workspaces.length === 1 ? path.basename(workspaces[0]) : `${workspaces.length} projects`;
    const choice = await vscode.window.showWarningMessage(
      `${label} all changes in ${where}? ${total} file${total === 1 ? "" : "s"} will be ${
        kind === "accept" ? "kept" : "reverted to their baseline"
      }.`,
      { modal: true },
      label,
    );
    if (choice !== label) {
      return;
    }

    let reloaded = 0;
    for (const ws of workspaces) {
      for (const s of hub.store.listChangeSets(ws)) {
        if (kind === "accept") {
          hub.store.accept(s.id);
        } else {
          hub.store.reject(s.id);
        }
        const cs = hub.store.findById(s.id);
        if (cs) {
          watcher.noteSelfWrite(cs.absPath);
          await staged.restage(cs.id);
          if (!staged.changeIdFor(cs.absPath)) {
            reloaded += reloadOpenEditors(
              vscode.workspace.textDocuments,
              vscode.Uri.file(cs.absPath).fsPath,
              (uri) => void vscode.commands.executeCommand("workbench.action.files.revert", uri),
            );
          }
        }
      }
    }
    refreshUi();
    logger.info(
      `${kind}All: ${total} change(s) across ${workspaces.length} workspace(s), editors reloaded=${reloaded}`,
    );
  }

  logger.info("Review Hub activated");
}

export const AGENT_RULES_BLOCK = [
  "<!-- review-hub:start -->",
  "## Review Hub (required)",
  "",
  "This project uses Review Hub to review AI edits. **Do not use the built-in `edit`,",
  "`write`, or shell commands to modify source files.** Use the Review Hub MCP tools",
  "instead, so every change is recorded and the user can accept or reject each hunk:",
  "",
  "- `mcp__review_hub__propose_edit` — change a file. Same arguments as the native edit",
  "  tool: `path`, `old_string`, `new_string`, optional `replace_all`.",
  "  **Use this instead of `edit`.**",
  "- `mcp__review_hub__propose_write` — create or replace a whole file (`path`, `content`).",
  "  **Use this instead of `write`.**",
  "- `mcp__review_hub__propose_delete` — delete a file (`path`).",
  "  **Use this instead of `rm`**.",
  "- `mcp__review_hub__read_file` — read a file (`path`).",
  "- `mcp__review_hub__list_changes` — list files changed since the last accepted checkpoint.",
  "- Review Hub **does not write your edit to disk until the user accepts it**. Reading the file",
  "  with your own tools will show the OLD content — that is expected, not a failed edit.",
  "- Use the `read_file` tool (not `cat`/Read) to see the content you have staged so far.",
  "",
  "A `propose_*` call returns `status: \"staged_for_review\"` with a `changeId`. That is",
  "**success, not an error**. The edit is staged and the user reviews it; do not retry with",
  "a different tool and do not ask for confirmation.",
  "",
  "Only fall back to the built-in tools if a Review Hub tool returns an error saying the hub",
  "is unreachable.",
  "<!-- review-hub:end -->",
  "",
].join("\n");

async function copyAgentRulesSnippet(): Promise<void> {
  await vscode.env.clipboard.writeText(AGENT_RULES_BLOCK);
  void vscode.window.showInformationMessage(
    "Review Hub AI agent rules copied to clipboard! Paste it into CLAUDE.md, .cursorrules, .clinerules, or AGENTS.md in your project root.",
  );
}

async function copyMcpConfigSnippet(): Promise<void> {
  const config = {
    mcpServers: {
      "review-hub": {
        command: "npx",
        args: ["-y", "review-hub-mcp"]
      }
    }
  };
  await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
  void vscode.window.showInformationMessage(
    "Review Hub MCP configuration copied to clipboard! Paste it into your AI tool settings (~/.claude.json, Cline, Roo Code, etc.)."
  );
}

async function installInstructions(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Review Hub: open a folder first.");
    return;
  }
  const block = AGENT_RULES_BLOCK;

  for (const folder of folders) {
    for (const name of ["AGENTS.md", "CLAUDE.md", ".clinerules", ".cursorrules", ".windsurfrules"]) {
      const file = vscode.Uri.joinPath(folder.uri, name);
      let existing = "";
      try {
        existing = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
      } catch {
        existing = "";
      }
      const marker = /<!-- review-hub:start -->[\s\S]*?<!-- review-hub:end -->\n?/;
      const next = marker.test(existing) ? existing.replace(marker, block) : `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}\n${block}`;
      await vscode.workspace.fs.writeFile(file, Buffer.from(next, "utf8"));
    }
  }
  void vscode.window.showInformationMessage("Review Hub: agent instructions installed in AGENTS.md, CLAUDE.md, .clinerules, .cursorrules, .windsurfrules.");
}

export async function deactivate(): Promise<void> {
  const pending = runtime;
  runtime = undefined;
  if (!pending) {
    return; // never activated (or already flushed)
  }
  try {
    const result = flushPendingReviews(pending.store, pending.workspaces());
    // D6: the flush just wrote the resolved bytes — hand every staged buffer back to what is
    // now on disk, so no merged view survives into the next session (spec D6/F1/F3): a merged
    // view left behind has no record left to adopt it, so a routine save would write display
    // text (the F1 corruption path). Scoped to engine entries only; each revert is awaited —
    // a fire-and-forget one may never execute once the host tears down.
    let reverted = 0;
    for (const fsPath of pending.staged.stagedPaths()) {
      await vscode.commands.executeCommand("workbench.action.files.revert", vscode.Uri.file(fsPath));
      reverted++;
      const changeId = pending.staged.changeIdFor(fsPath);
      if (changeId) {
        pending.staged.unstage(changeId); // context key honest while the window finishes closing
      }
    }
    pending.log(
      `exit flush: ${result.accepted} change(s) accepted across ${result.workspaces} workspace(s), cache pruned, ${reverted} staged buffer(s) reverted`,
    );
  } catch (err) {
    // Never block window teardown on a flush.
    pending.log(`exit flush failed: ${String(err)}`);
  }
}
