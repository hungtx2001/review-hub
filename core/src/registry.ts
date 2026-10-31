/**
 * Hub discovery registry: how the stdio MCP server (a separate process) finds the
 * running Review Hub extension. Adapted from the dsh extension's registry pattern:
 * atomic write, `wx` lockfile with stale-steal, and `fs.watch`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REGISTRY_FILE = "hub.json";
const LOCK_FILE = "hub.lock";
const LOCK_STALE_MS = 120_000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_POLL_MS = 200;

export interface HubEntry {
  url: string;
  token: string;
  pid: number;
  /** Real (resolved) workspace path this hub is serving. */
  workspace: string;
  updatedAt: number;
  protocol: number;
}

export interface Registry {
  readEntry(): HubEntry | undefined;
  writeEntry(entry: HubEntry): void;
  clearEntry(): void;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  watch(onChange: (entry: HubEntry) => void): () => void;
}

function isEntry(value: unknown): value is HubEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return typeof r.url === "string" && typeof r.token === "string" && typeof r.pid === "number";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultBaseDir(): string {
  return process.env.REVIEW_HUB_DIR ?? path.join(os.homedir(), ".review-hub");
}

export function createRegistry(baseDir = defaultBaseDir()): Registry {
  const filePath = path.join(baseDir, REGISTRY_FILE);
  const lockPath = path.join(baseDir, LOCK_FILE);

  const readEntry = (): HubEntry | undefined => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return isEntry(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const writeEntry = (entry: HubEntry): void => {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(tmp, filePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EEXIST") {
        try {
          fs.unlinkSync(filePath);
          fs.renameSync(tmp, filePath);
          return;
        } catch {
          fs.copyFileSync(tmp, filePath);
          try { fs.unlinkSync(tmp); } catch {}
          return;
        }
      }
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  };

  const clearEntry = (): void => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // nothing stored
    }
  };

  const lockIsStale = (): boolean => {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  };

  const acquireLock = async (): Promise<void> => {
    fs.mkdirSync(baseDir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = fs.openSync(lockPath, "wx");
        fs.writeSync(handle, String(process.pid));
        fs.closeSync(handle);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        if (lockIsStale()) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // another process stole it; retry
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the Review Hub lock at ${lockPath}`);
        }
        await sleep(LOCK_POLL_MS);
      }
    }
  };

  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquireLock();
    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already released
      }
    }
  };

  const watch = (onChange: (entry: HubEntry) => void): (() => void) => {
    fs.mkdirSync(baseDir, { recursive: true });
    const watcher = fs.watch(baseDir, (_event, filename) => {
      if (filename !== null && filename !== REGISTRY_FILE) {
        return;
      }
      const entry = readEntry();
      if (entry) {
        onChange(entry);
      }
    });
    return () => watcher.close();
  };

  return { readEntry, writeEntry, clearEntry, withLock, watch };
}

export const registry = createRegistry();
