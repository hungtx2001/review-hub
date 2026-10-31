/**
 * Persistence for checkpoints, change sets, and baseline blobs.
 *
 * `JsonBackend` is the original file-backed implementation, moved here unchanged: one
 * directory per workspace under `~/.review-hub/workspaces/<hash>/`, one JSON file per
 * change set, plus `checkpoint.json`. It is the fallback when `node:sqlite` is missing.
 *
 * `SqliteBackend` (see the bottom of this file) stores the same records in one
 * `~/.review-hub/hub.db`. Baseline *blobs* stay content-addressed on disk in both
 * backends — they can be megabytes, and moving them into SQLite would mean rewriting
 * large values on every decision for no benefit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic, deleteFileSafe, hashContent } from "./file-snapshot";
import type { ChangeSet } from "./types";
import type { SqlDriver } from "./sqlite";

export interface CheckpointRecord {
  workspace: string;
  setAt: number;
  files: Record<string, string>; // relPath -> content hash
  /** True when the walk hit maxFiles/maxDurationMs and did not see the whole tree. */
  truncated?: boolean;
}

export interface StoreBackend {
  readCheckpoint(workspace: string): CheckpointRecord | undefined;
  writeCheckpoint(cp: CheckpointRecord): void;
  clearCheckpoint(workspace: string): void;
  knownWorkspaces(): string[];

  writeChange(cs: ChangeSet): void;
  getChange(workspace: string, id: string): ChangeSet | undefined;
  listChangeSets(workspace: string): ChangeSet[];
  findById(id: string): ChangeSet | undefined;
  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined;
  removeChange(workspace: string, id: string): void;
  clearChanges(workspace: string): void;
  pruneResolved(maxAgeMs: number): void;

  putBaseline(workspace: string, content: string): string;
  getBaseline(workspace: string, hash: string): string;

  dispose(): void;
}

export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}

/** Content-addressed baseline storage, shared by both backends. */
export class BaselineBlobs {
  constructor(private baseDir: string) {}

  private dir(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace), "baselines");
  }

  put(workspace: string, content: string): string {
    const hash = hashContent(content);
    const file = path.join(this.dir(workspace), hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, content);
    }
    return hash;
  }

  get(workspace: string, hash: string): string {
    try {
      return fs.readFileSync(path.join(this.dir(workspace), hash), "utf8");
    } catch {
      return "";
    }
  }
}

export class JsonBackend implements StoreBackend {
  private blobs: BaselineBlobs;
  /**
   * In-memory cache of change sets per workspace. CodeLens and the panel call the list
   * methods on every keystroke / render, so re-reading every JSON from disk each time is
   * wasteful. Revalidated against the changes directory's mtime, because the store is
   * shared: another VS Code window may write changes we must see.
   */
  private cache = new Map<string, { at: number; items: ChangeSet[] }>();

  constructor(private baseDir: string) {
    this.blobs = new BaselineBlobs(baseDir);
  }

  private wsDir(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace));
  }

  private checkpointPath(workspace: string): string {
    return path.join(this.wsDir(workspace), "checkpoint.json");
  }

  private changesDir(workspace: string): string {
    return path.join(this.wsDir(workspace), "changes");
  }

  private changePath(workspace: string, id: string): string {
    return path.join(this.changesDir(workspace), `${id}.json`);
  }

  private invalidate(workspace: string): void {
    this.cache.delete(workspace);
  }

  private changesDirMtime(workspace: string): number {
    try {
      return fs.statSync(this.changesDir(workspace)).mtimeMs;
    } catch {
      return 0;
    }
  }

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.checkpointPath(workspace), "utf8")) as CheckpointRecord;
      if (parsed && typeof parsed === "object" && parsed.files) {
        return parsed;
      }
    } catch {
      // none yet
    }
    return undefined;
  }

  writeCheckpoint(cp: CheckpointRecord): void {
    fs.mkdirSync(this.wsDir(cp.workspace), { recursive: true });
    writeFileAtomic(this.checkpointPath(cp.workspace), `${JSON.stringify(cp, null, 2)}\n`);
  }

  clearCheckpoint(workspace: string): void {
    deleteFileSafe(this.checkpointPath(workspace));
    this.clearChanges(workspace);
  }

  knownWorkspaces(): string[] {
    const root = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(root);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const key of keys) {
      const dir = path.join(root, key);
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(dir, "checkpoint.json"), "utf8")) as { workspace?: string };
        if (cp?.workspace) {
          out.push(cp.workspace);
          continue;
        }
      } catch {
        // no checkpoint
      }
      try {
        const names = fs.readdirSync(path.join(dir, "changes")).filter((n) => n.endsWith(".json"));
        if (names.length > 0) {
          const cs = JSON.parse(fs.readFileSync(path.join(dir, "changes", names[0]), "utf8")) as { workspace?: string };
          if (cs?.workspace) {
            out.push(cs.workspace);
          }
        }
      } catch {
        // nothing usable
      }
    }
    return out;
  }

  writeChange(cs: ChangeSet): void {
    fs.mkdirSync(this.changesDir(cs.workspace), { recursive: true });
    writeFileAtomic(this.changePath(cs.workspace, cs.id), `${JSON.stringify(cs, null, 2)}\n`);
    this.invalidate(cs.workspace);
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.changePath(workspace, id), "utf8")) as ChangeSet;
      return parsed && parsed.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  listChangeSets(workspace: string): ChangeSet[] {
    const mtime = this.changesDirMtime(workspace);
    const cached = this.cache.get(workspace);
    if (cached && cached.at === mtime) {
      return cached.items;
    }
    const dir = this.changesDir(workspace);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      this.cache.set(workspace, { at: mtime, items: [] });
      return [];
    }
    const out: ChangeSet[] = [];
    for (const name of names) {
      try {
        const cs = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ChangeSet;
        // Resolved sets are kept only so an open review tab can render its final state;
        // they are not "changes awaiting review" any more.
        if (cs && cs.id && cs.status !== "resolved") {
          out.push(cs);
        }
      } catch {
        // skip corrupt
      }
    }
    // One row per file, always the latest edit.
    const latest = new Map<string, ChangeSet>();
    for (const cs of out) {
      const prev = latest.get(cs.path);
      if (!prev || (cs.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
        latest.set(cs.path, cs);
      }
    }
    const items = [...latest.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.cache.set(workspace, { at: mtime, items });
    return items;
  }

  findById(id: string): ChangeSet | undefined {
    const workspacesDir = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(workspacesDir);
    } catch {
      return undefined;
    }
    for (const key of keys) {
      const file = path.join(workspacesDir, key, "changes", `${id}.json`);
      try {
        const cs = JSON.parse(fs.readFileSync(file, "utf8")) as ChangeSet;
        if (cs && cs.id === id) {
          return cs;
        }
      } catch {
        // try next
      }
    }
    return undefined;
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    const p = relPath.split(path.sep).join("/");
    return this.listChangeSets(workspace).find((cs) => cs.path === p);
  }

  removeChange(workspace: string, id: string): void {
    deleteFileSafe(this.changePath(workspace, id));
    this.invalidate(workspace);
  }

  clearChanges(workspace: string): void {
    const dir = this.changesDir(workspace);
    try {
      for (const name of fs.readdirSync(dir)) {
        deleteFileSafe(path.join(dir, name));
      }
    } catch {
      // none
    }
    this.invalidate(workspace);
  }

  pruneResolved(maxAgeMs: number): void {
    const root = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(root);
    } catch {
      return;
    }
    const now = Date.now();
    for (const key of keys) {
      const dir = path.join(root, key, "changes");
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      let removed = false;
      for (const name of names) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const file = path.join(dir, name);
        try {
          const cs = JSON.parse(fs.readFileSync(file, "utf8")) as ChangeSet;
          // `>=` rather than `>` so `pruneResolved(0)` reliably drops a set that was just
          // resolved in the same millisecond ("older than 0ms" holds for anything).
          if (cs.status === "resolved" && now - (cs.updatedAt ?? 0) >= maxAgeMs) {
            deleteFileSafe(file);
            removed = true;
          }
        } catch {
          // skip
        }
      }
      if (removed) {
        this.invalidate(path.join(root, key));
      }
    }
  }

  putBaseline(workspace: string, content: string): string {
    return this.blobs.put(workspace, content);
  }

  getBaseline(workspace: string, hash: string): string {
    return this.blobs.get(workspace, hash);
  }

  dispose(): void {
    this.cache.clear();
  }
}

// ---- SQLite backend ---------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  workspace  TEXT PRIMARY KEY,
  set_at     INTEGER NOT NULL,
  files_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  path            TEXT NOT NULL,
  abs_path        TEXT NOT NULL,
  origin          TEXT NOT NULL,
  applied         INTEGER NOT NULL,
  status          TEXT NOT NULL,
  eol             TEXT NOT NULL,
  bom             INTEGER NOT NULL,
  final_newline   INTEGER NOT NULL,
  binary          INTEGER NOT NULL,
  baseline_b64    INTEGER NOT NULL DEFAULT 0,
  baseline        TEXT NOT NULL,
  proposed        TEXT NOT NULL,
  baseline_exists INTEGER NOT NULL,
  proposed_exists INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (workspace, path)
);
CREATE TABLE IF NOT EXISTS hunks (
  change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  old_start INTEGER NOT NULL,
  new_start INTEGER NOT NULL,
  old_lines TEXT NOT NULL,
  new_lines TEXT NOT NULL,
  decision  TEXT NOT NULL,
  PRIMARY KEY (change_id, id)
);
CREATE INDEX IF NOT EXISTS idx_changes_workspace ON changes(workspace);
CREATE INDEX IF NOT EXISTS idx_changes_status    ON changes(workspace, status);
`;

interface ChangeRow {
  id: string;
  workspace: string;
  path: string;
  abs_path: string;
  origin: string;
  applied: number;
  status: string;
  eol: string;
  bom: number;
  final_newline: number;
  binary: number;
  baseline_b64: number;
  baseline: string;
  proposed: string;
  baseline_exists: number;
  proposed_exists: number;
  created_at: number;
  updated_at: number;
}

interface HunkRow {
  change_id: string;
  id: string;
  ordinal: number;
  old_start: number;
  new_start: number;
  old_lines: string;
  new_lines: string;
  decision: string;
}

function rowToChangeSet(row: ChangeRow, hunks: HunkRow[]): ChangeSet {
  return {
    id: row.id,
    workspace: row.workspace,
    path: row.path,
    absPath: row.abs_path,
    origin: row.origin as ChangeSet["origin"],
    applied: row.applied === 1,
    status: row.status as ChangeSet["status"],
    eol: row.eol === "\r\n" ? "\r\n" : "\n",
    bom: row.bom === 1,
    finalNewline: row.final_newline === 1,
    binary: row.binary === 1,
    baseline: row.baseline,
    baselineB64: row.baseline_b64 === 1,
    proposed: row.proposed,
    baselineExists: row.baseline_exists === 1,
    proposedExists: row.proposed_exists === 1,
    hunks: hunks.map((h) => ({
      id: h.id,
      oldStart: h.old_start,
      oldLines: JSON.parse(h.old_lines) as string[],
      newStart: h.new_start,
      newLines: JSON.parse(h.new_lines) as string[],
      decision: h.decision as ChangeSet["hunks"][number]["decision"],
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteBackend implements StoreBackend {
  private blobs: BaselineBlobs;
  private closed = false;

  constructor(private driver: SqlDriver, baseDir?: string) {
    this.blobs = new BaselineBlobs(baseDir ?? path.join(process.env.HOME ?? "", ".review-hub"));
    this.driver.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive, idempotent migrations. `CREATE TABLE IF NOT EXISTS` never alters an existing
   * table, so a database written by an earlier revision must be brought forward explicitly.
   * Guarded on `PRAGMA table_info` so re-opening an up-to-date database is a no-op.
   */
  private migrate(): void {
    const cols = this.driver.all<{ name: string }>("PRAGMA table_info(changes)");
    if (!cols.some((c) => c.name === "baseline_b64")) {
      this.driver.exec("ALTER TABLE changes ADD COLUMN baseline_b64 INTEGER NOT NULL DEFAULT 0");
      // Backfill from the stored prefix: an encoded baseline was written as `bin:`/`b64:` + base64,
      // a raw one is plain utf8. Keying off `binary` would be WRONG — oversize *text* rows also carry
      // `binary = 1` but store raw utf8 (see `observeBinary`), and decoding those would corrupt them.
      this.driver.run("UPDATE changes SET baseline_b64 = 1 WHERE substr(baseline, 1, 4) IN ('bin:', 'b64:')");
    }
  }

  // ---- checkpoints ----

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    const row = this.driver.get<{ workspace: string; set_at: number; files_json: string }>(
      "SELECT workspace, set_at, files_json FROM checkpoints WHERE workspace = ?",
      workspace,
    );
    if (!row) {
      return undefined;
    }
    return {
      workspace: row.workspace,
      setAt: row.set_at,
      files: JSON.parse(row.files_json) as Record<string, string>,
    };
  }

  writeCheckpoint(cp: CheckpointRecord): void {
    this.driver.run(
      "INSERT OR REPLACE INTO checkpoints (workspace, set_at, files_json) VALUES (?, ?, ?)",
      cp.workspace,
      cp.setAt,
      JSON.stringify(cp.files),
    );
  }

  clearCheckpoint(workspace: string): void {
    this.driver.run("DELETE FROM checkpoints WHERE workspace = ?", workspace);
    this.clearChanges(workspace);
  }

  knownWorkspaces(): string[] {
    const rows = this.driver.all<{ workspace: string }>(
      "SELECT workspace FROM checkpoints UNION SELECT workspace FROM changes",
    );
    return rows.map((r) => r.workspace);
  }

  // ---- changes ----

  writeChange(cs: ChangeSet): void {
    this.driver.transaction(() => {
      // `INSERT OR REPLACE` on the unique (workspace, path) row. The id is derived
      // deterministically from (workspace, path), so a re-propose of the same file
      // replaces its own row rather than colliding with it.
      this.driver.run(
        `INSERT OR REPLACE INTO changes
           (id, workspace, path, abs_path, origin, applied, status, eol, bom, final_newline,
            binary, baseline_b64, baseline, proposed, baseline_exists, proposed_exists, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        cs.id,
        cs.workspace,
        cs.path,
        cs.absPath,
        cs.origin,
        Number(cs.applied),
        cs.status,
        cs.eol,
        Number(cs.bom),
        Number(cs.finalNewline),
        Number(cs.binary),
        Number(cs.baselineB64 ?? false),
        cs.baseline,
        cs.proposed,
        Number(cs.baselineExists),
        Number(cs.proposedExists),
        cs.createdAt,
        cs.updatedAt,
      );
      // Delete explicitly rather than relying on ON DELETE CASCADE firing for a REPLACE.
      this.driver.run("DELETE FROM hunks WHERE change_id = ?", cs.id);
      cs.hunks.forEach((h, ordinal) => {
        this.driver.run(
          `INSERT INTO hunks (change_id, id, ordinal, old_start, new_start, old_lines, new_lines, decision)
           VALUES (?,?,?,?,?,?,?,?)`,
          cs.id,
          h.id,
          ordinal,
          h.oldStart,
          h.newStart,
          JSON.stringify(h.oldLines),
          JSON.stringify(h.newLines),
          h.decision,
        );
      });
    });
  }

  private hunksFor(ids: string[]): Map<string, HunkRow[]> {
    const out = new Map<string, HunkRow[]>();
    if (ids.length === 0) {
      return out;
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.driver.all<HunkRow>(
      `SELECT * FROM hunks WHERE change_id IN (${placeholders}) ORDER BY change_id, ordinal`,
      ...ids,
    );
    for (const row of rows) {
      const list = out.get(row.change_id) ?? [];
      list.push(row);
      out.set(row.change_id, list);
    }
    return out;
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND id = ?",
      workspace,
      id,
    );
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([id]).get(id) ?? []);
  }

  findById(id: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>("SELECT * FROM changes WHERE id = ?", id);
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([id]).get(id) ?? []);
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND path = ? AND status != 'resolved'",
      workspace,
      relPath.split(path.sep).join("/"),
    );
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([row.id]).get(row.id) ?? []);
  }

  listChangeSets(workspace: string): ChangeSet[] {
    const rows = this.driver.all<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND status != 'resolved' ORDER BY path",
      workspace,
    );
    if (rows.length === 0) {
      return [];
    }
    const hunks = this.hunksFor(rows.map((r) => r.id));
    const out = rows.map((r) => rowToChangeSet(r, hunks.get(r.id) ?? []));
    // UNIQUE (workspace, path) already guarantees one row per file; the dedupe mirrors
    // JsonBackend so the two backends cannot drift if that constraint ever changes.
    const latest = new Map<string, ChangeSet>();
    for (const cs of out) {
      const prev = latest.get(cs.path);
      if (!prev || (cs.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
        latest.set(cs.path, cs);
      }
    }
    return [...latest.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  removeChange(workspace: string, id: string): void {
    this.driver.run("DELETE FROM changes WHERE workspace = ? AND id = ?", workspace, id);
  }

  clearChanges(workspace: string): void {
    this.driver.run("DELETE FROM changes WHERE workspace = ?", workspace);
  }

  pruneResolved(maxAgeMs: number): void {
    // `<=` (not `<`) to match JsonBackend's `now - updatedAt >= maxAgeMs`, so
    // `pruneResolved(0)` drops a set resolved in the same millisecond in both backends.
    this.driver.run("DELETE FROM changes WHERE status = 'resolved' AND updated_at <= ?", Date.now() - maxAgeMs);
  }

  // ---- baselines (content-addressed blobs on disk, same as JsonBackend) ----

  putBaseline(workspace: string, content: string): string {
    return this.blobs.put(workspace, content);
  }

  getBaseline(workspace: string, hash: string): string {
    return this.blobs.get(workspace, hash);
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.driver.close();
  }
}
