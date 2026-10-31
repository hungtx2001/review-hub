/**
 * Baseline content for the direct-write (watcher) path.
 *
 * The watcher fires *after* a file changes, so the pre-change content is gone from
 * disk. Rather than snapshotting the whole workspace up front (expensive on large or
 * network filesystems), we recover the pre-change content from git — the repo already
 * stores it, and `git show HEAD:<path>` is instant.
 *
 * No `vscode` import so it is unit-testable.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";

export interface GitBaseline {
  /** Whether the workspace is inside a git work tree. */
  isRepo: boolean;
  /** HEAD content of the path, or null when the file is not tracked at HEAD. */
  content: string | null;
}

export interface GitBaselineBytes {
  /** Whether the workspace is inside a git work tree. */
  isRepo: boolean;
  /** HEAD bytes of the path, or null when the file is not tracked at HEAD. */
  bytes: Buffer | null;
}

const MAX_BUFFER = 8 * 1024 * 1024;

function run(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, timeout: 4000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, stdout: "" });
        return;
      }
      resolve({ ok: true, stdout: String(stdout) });
    });
  });
}

/** Like `run`, but keeps stdout as raw bytes so binaries survive the read. */
function runBuffer(args: string[], cwd: string): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER, timeout: 4000, encoding: "buffer" },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, stdout: Buffer.alloc(0) });
          return;
        }
        resolve({ ok: true, stdout: stdout as unknown as Buffer });
      },
    );
  });
}

/** Read the HEAD version of a workspace-relative path. */
export async function readGitBaseline(workspace: string, relPath: string): Promise<GitBaseline> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  // Reject traversal before shelling out.
  const abs = path.resolve(workspace, rel);
  const relFromWs = path.relative(workspace, abs);
  if (!relFromWs || relFromWs.startsWith("..") || path.isAbsolute(relFromWs)) {
    return { isRepo: false, content: null };
  }
  const inside = await run(["rev-parse", "--is-inside-work-tree"], workspace);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isRepo: false, content: null };
  }
  const show = await run(["show", `HEAD:${rel}`], workspace);
  if (!show.ok) {
    // Tracked at HEAD but removed, or never committed.
    return { isRepo: true, content: null };
  }
  return { isRepo: true, content: show.stdout };
}

/**
 * Byte-exact sibling of `readGitBaseline`. Binary content cannot round-trip through a
 * utf8 string (invalid sequences become U+FFFD), so the binary/oversize path needs the
 * raw bytes of the HEAD blob. Same traversal guard and repo probe as `readGitBaseline`.
 */
export async function readGitBaselineBytes(
  workspace: string,
  relPath: string,
): Promise<GitBaselineBytes> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(workspace, rel);
  const relFromWs = path.relative(workspace, abs);
  if (!relFromWs || relFromWs.startsWith("..") || path.isAbsolute(relFromWs)) {
    return { isRepo: false, bytes: null };
  }
  const inside = await run(["rev-parse", "--is-inside-work-tree"], workspace);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isRepo: false, bytes: null };
  }
  const show = await runBuffer(["show", `HEAD:${rel}`], workspace);
  if (!show.ok) {
    return { isRepo: true, bytes: null };
  }
  return { isRepo: true, bytes: show.stdout };
}

/** True when git is available and the workspace is a work tree (cheap check, cached by callers). */
export async function isGitRepo(workspace: string): Promise<boolean> {
  const r = await run(["rev-parse", "--is-inside-work-tree"], workspace);
  return r.ok && r.stdout.trim() === "true";
}

/**
 * List the workspace-relative paths git reports as changed (modified, added, deleted,
 * untracked). This is the detection mechanism that works even where inotify does not —
 * a WSL 9p mount (/mnt/d, /home/... on a Windows drive) never delivers fs events, but
 * `git status` reads the index directly and always sees the truth.
 *
 * Returns null when the workspace is not a git repo.
 *
 * `repoState` is an optional memo of "is this workspace a repo". Whether a path is a git
 * work tree never changes during a session, and each `git` invocation costs a process
 * spawn (~0.3 s on 9p), so the poll loop passes a map here to skip the `rev-parse` probe
 * on every tick.
 */
export async function gitChangedFiles(
  workspace: string,
  repoState?: Map<string, boolean>,
): Promise<string[] | null> {
  let isRepo = repoState?.get(workspace);
  if (isRepo === undefined) {
    const inside = await run(["rev-parse", "--is-inside-work-tree"], workspace);
    isRepo = inside.ok && inside.stdout.trim() === "true";
    repoState?.set(workspace, isRepo);
  }
  if (!isRepo) {
    return null;
  }
  // -z gives NUL-separated entries with no quoting, so odd file names survive intact.
  const r = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace);
  if (!r.ok) {
    // A failure can mean the repo was moved/removed under us; drop the memo so the next
    // poll re-probes instead of trusting a stale "yes".
    repoState?.delete(workspace);
    return null;
  }
  const parts = r.stdout.split("\0").filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename/copy entry is followed by the original path as a separate record; skip it.
    if (status.includes("R") || status.includes("C")) {
      i++;
    }
    out.push(file);
  }
  return out;
}
