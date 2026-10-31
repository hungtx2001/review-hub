/**
 * Change detection that works regardless of the agent's permission mode AND regardless
 * of the filesystem.
 *
 * Three mechanisms, in order of preference:
 *   1. VS Code's own file watcher (inotify) — instant, but delivers nothing on a WSL 9p
 *      mount (a Windows drive under /mnt or /home/<user>/Work), which is common here.
 *   2. `git status` polling — reads the index directly, so it always sees edits even
 *      where inotify is dead. Cheap on any repo size.
 *   3. A bounded directory scan — the fallback for a workspace that is not a git repo.
 *
 * The result feeds the same ChangeStore, so the UI does not care which path found it.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeStore } from "../../../core/src/change-store";
import { globToRegExp } from "../../../core/src/change-store";
import { gitChangedFiles } from "../../../core/src/git-baseline";

const POLL_MS = 3000;
const SCAN_MAX_FILES = 20_000;
/** Yield to the event loop after this many entries during a scan. */
const SCAN_YIELD_EVERY = 250;
/**
 * Every Nth poll is a "safety" poll that also covers workspaces whose filesystem does
 * deliver native events. Keeps the cheap path cheap without ever going fully blind.
 */
const SAFETY_EVERY = 10;

/** 9p (WSL drvfs) magic; inotify never fires on it, so polling is the only mechanism. */
const NINE_P_MAGIC = 0x01021997;

/**
 * True when a workspace needs active polling because the native file watcher cannot see
 * its filesystem. On 9p that is always; elsewhere the native watcher is enough and
 * polling would just burn CPU and disk on `git status`.
 *
 * `statfsSync` is a syscall, so the answer is memoized per path — the filesystem type
 * cannot change under a workspace during a session.
 */
const pollingNeeded = new Map<string, boolean>();
function needsPolling(workspace: string): boolean {
  const hit = pollingNeeded.get(workspace);
  if (hit !== undefined) {
    return hit;
  }
  let result: boolean;
  try {
    result = fs.statfsSync(workspace).type === NINE_P_MAGIC;
  } catch {
    // If we cannot tell, poll — a missed change is worse than some extra work.
    result = true;
  }
  pollingNeeded.set(workspace, result);
  return result;
}

export class WorkspaceWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  /** Paths we just wrote ourselves; ignore the resulting change events. */
  private selfWrites = new Set<string>();
  private pending = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private pollCount = 0;
  /** Last seen mtime+size per absolute path, for the non-git scan fallback. */
  private scanState = new Map<string, string>();
  /** Memo of "is this workspace a git repo", so the poll loop skips the probe. */
  private repoState = new Map<string, boolean>();
  /** Whether this window currently has focus; polling is suspended while it does not. */
  private focused = true;
  constructor(
    private store: ChangeStore,
    private getWorkspaces: () => string[],
    private excludeGlobs: string[],
    private onChanged: (workspace: string, relPath: string) => void,
    /** Source extensions worth baselining; empty/undefined means "any". */
    private includeExtensions: string[] = [],
  ) {}

  start(): void {
    // 1. Native watcher — instant where inotify works. Skip it entirely when no workspace
    //    is on such a filesystem (e.g. all 9p): there it delivers nothing, but VS Code
    //    still watches the whole tree, which is real disk/CPU load for zero benefit.
    const workspaces = this.getWorkspaces();
    const watcherHelps = workspaces.length === 0 || workspaces.some((ws) => !needsPolling(ws));
    if (watcherHelps) {
      this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
      const handle = (uri: vscode.Uri) => this.schedule(uri);
      this.disposables.push(
        this.watcher.onDidChange(handle),
        this.watcher.onDidCreate(handle),
        this.watcher.onDidDelete(handle),
      );
    }

    // 2 + 3. Polling fallback, so detection never depends on inotify.
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);

    // A background window cannot show the user anything, and with several windows open
    // the per-window `git status` polling is what made opening many windows expensive.
    // Suspend polling while the window is unfocused and poll once on refocus, so the
    // changes are there the moment the user looks.
    this.focused = vscode.window.state?.focused ?? true;
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.focused = state.focused;
        if (state.focused) {
          void this.poll();
        }
      }),
    );
  }

  /** Call immediately after writing a file ourselves so we do not echo it back. */
  noteSelfWrite(absPath: string): void {
    this.selfWrites.add(absPath);
    setTimeout(() => this.selfWrites.delete(absPath), 2000);
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    // A window the user is not looking at does not need to poll: nothing it finds could
    // be shown. Refocusing triggers an immediate poll, so this never delays a change.
    if (!this.focused) {
      return;
    }
    this.polling = true;
    const tick = ++this.pollCount;
    try {
      for (const ws of this.getWorkspaces()) {
        // On a filesystem where the native watcher works (anything but 9p), polling every
        // 3 s is pure waste: `git status` alone costs ~1 s here, and every open window ran
        // it. Poll such a workspace only every Nth tick, as a safety net.
        if (!needsPolling(ws) && tick % SAFETY_EVERY !== 0) {
          continue;
        }
        const viaGit = await gitChangedFiles(ws, this.repoState);
        if (viaGit) {
          for (const rel of viaGit) {
            await this.record(ws, rel);
          }
        } else {
          await this.scanWorkspace(ws);
        }
      }
    } catch {
      // best effort; a transient failure must not kill the timer
    } finally {
      this.polling = false;
    }
  }

  /**
   * Bounded recursive scan for workspaces that are not git repos.
   *
   * Uses async `readdir` and yields to the event loop regularly: a synchronous walk of a
   * large tree on a WSL 9p mount blocks the extension host for ~1 s per pass and was a
   * main cause of the CPU/disk load. Only `readdir` is done up front; `stat` runs per
   * file below, and the whole thing yields every `SCAN_YIELD_EVERY` entries.
   */
  private async scanWorkspace(workspace: string): Promise<void> {
    const found: string[] = [];
    let seen = 0;
    const walk = async (dir: string): Promise<void> => {
      if (found.length >= SCAN_MAX_FILES) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= SCAN_MAX_FILES) {
          return;
        }
        const abs = path.join(dir, entry.name);
        const rel = path.relative(workspace, abs).split(path.sep).join("/");
        // Prune excluded directories here, before descending: the glob now matches the
        // bare directory name, so node_modules/.git/dist are skipped wholesale instead
        // of being walked and filtered file by file.
        if (isExcluded(rel, this.excludeGlobs)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        found.push(rel);
        if (++seen % SCAN_YIELD_EVERY === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    };
    await walk(workspace);

    // Seed baselines for files never seen before in one batched checkpoint write, then
    // observe only the ones whose mtime+size actually changed.
    const fresh: string[] = [];
    const changed: string[] = [];
    for (const rel of found) {
      const abs = path.join(workspace, rel);
      let key: string;
      try {
        const st = await fs.promises.stat(abs);
        key = `${st.mtimeMs}:${st.size}`;
      } catch {
        key = "gone";
      }
      const prev = this.scanState.get(abs);
      if (prev === undefined) {
        fresh.push(rel);
      } else if (prev !== key) {
        changed.push(rel);
      }
      this.scanState.set(abs, key);
    }
    if (fresh.length > 0) {
      // First sighting: record the current content as the baseline, so a file that was
      // already modified before we started is not reported as a change.
      this.store.captureBaselines(workspace, fresh, { includeExtensions: this.includeExtensions });
    }
    for (const rel of changed) {
      await this.record(workspace, rel);
    }
  }

  /** Observe one path and surface it if it represents a change. */
  private async record(workspace: string, relPath: string): Promise<void> {
    const abs = path.join(workspace, relPath);
    if (this.selfWrites.has(abs)) {
      return;
    }
    if (isExcluded(relPath, this.excludeGlobs)) {
      return;
    }
    const cs = await this.store.observe(workspace, relPath);
    if (cs) {
      this.onChanged(workspace, cs.path);
    }
  }

  private schedule(uri: vscode.Uri): void {
    if (uri.scheme !== "file") {
      return;
    }
    const abs = uri.fsPath;
    if (this.selfWrites.has(abs)) {
      return;
    }
    const rel = this.relativeToWorkspace(abs);
    if (!rel) {
      return;
    }
    if (isExcluded(rel, this.excludeGlobs)) {
      return;
    }
    const existing = this.pending.get(abs);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      abs,
      setTimeout(() => {
        this.pending.delete(abs);
        const workspace = this.workspaceFor(abs);
        if (!workspace) {
          return;
        }
        void this.store.observe(workspace, rel).then((cs) => {
          if (cs) {
            this.onChanged(workspace, cs.path);
          }
        });
      }, 250),
    );
  }

  private relativeToWorkspace(abs: string): string | undefined {
    for (const ws of this.getWorkspaces()) {
      const rel = path.relative(ws, abs);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
      }
    }
    return undefined;
  }

  private workspaceFor(abs: string): string | undefined {
    for (const ws of this.getWorkspaces()) {
      const rel = path.relative(ws, abs);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return ws;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    this.pending.clear();
  }
}

function isExcluded(rel: string, globs: string[]): boolean {
  for (const glob of globs) {
    if (globToRegExp(glob).test(rel)) {
      return true;
    }
  }
  return false;
}
