/**
 * A tiny cross-window registry: every VS Code window publishes the folders it has open,
 * the file the user is currently looking at, and when it was last focused.
 *
 * Why: the hub is ONE shared server hosted by whichever window won the election, so on its
 * own it only knows that window's folders. An agent's tool call carries a *relative* path
 * (`README.md`), which is ambiguous when several open projects contain that file — and a
 * harness spawns the MCP server with a working directory fixed at launch, so `cwd` is not a
 * reliable answer either. Publishing every window's folders and active file lets the MCP
 * server route a relative path to the project the user is actually working in.
 *
 * File-backed and best-effort: a window that crashes simply leaves a stale file, which is
 * ignored once its pid is gone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pidAlive } from "./registry";

export interface WindowState {
  pid: number;
  /** Absolute folder paths open in this window, in the window's own order. */
  folders: string[];
  /** The file in the active editor, if any. */
  activeFile?: string;
  /** When this window last had focus; the most recently focused window is preferred. */
  focusedAt: number;
  updatedAt: number;
}

function windowsDir(baseDir: string): string {
  return path.join(baseDir, "windows");
}

function stateFile(baseDir: string, pid: number): string {
  return path.join(windowsDir(baseDir), `${pid}.json`);
}

/** Publish this window's state, replacing any previous file. */
export function writeWindowState(baseDir: string, state: WindowState): void {
  try {
    fs.mkdirSync(windowsDir(baseDir), { recursive: true });
    const file = stateFile(baseDir, state.pid);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    try {
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(file);
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  } catch {
    // best effort; routing falls back to cwd
  }
}

/** Remove this window's state (on dispose). */
export function clearWindowState(baseDir: string, pid: number): void {
  try {
    fs.unlinkSync(stateFile(baseDir, pid));
  } catch {
    // already gone
  }
}

/**
 * Every live window's state, most recently focused first. Stale files (dead pids) are
 * deleted as a side effect, so the directory does not grow without bound.
 */
export function readWindowStates(baseDir: string): WindowState[] {
  const dir = windowsDir(baseDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: WindowState[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = JSON.parse(fs.readFileSync(file, "utf8")) as WindowState;
      if (!st || typeof st.pid !== "number") {
        continue;
      }
      if (st.pid !== process.pid && !pidAlive(st.pid)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
        continue;
      }
      out.push(st);
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0));
  return out;
}

export function defaultWindowsBaseDir(): string {
  return path.join(os.homedir(), ".review-hub");
}
