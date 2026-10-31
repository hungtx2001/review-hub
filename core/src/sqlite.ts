/**
 * A minimal wrapper over Node's built-in `node:sqlite` (`DatabaseSync`). No third-party
 * dependency, no external service — `node:sqlite` ships with Node, so it satisfies the
 * "write it by hand / no external APIs" constraint.
 *
 * Two runtime facts drive the shape of this file:
 *   1. `node:sqlite` is unflagged from Node 22.13.0 but still emits an
 *      `ExperimentalWarning` **at require time**. We filter that one warning — and only
 *      that one — by installing a `process.emitWarning` override *before* the require.
 *   2. Real Electron builds have shipped without the sqlite binding, so `openDatabase`
 *      returns `undefined` instead of throwing, and the caller falls back to the JSON
 *      store.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface StatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string, opts?: { timeout?: number }) => DatabaseLike;
}

const WARNING_FRAGMENT = "SQLite is an experimental feature";

let warned = false;
function warnOnce(message: string): void {
  if (warned) {
    return;
  }
  warned = true;
  // console.warn, not a vscode OutputChannel: this module is also loaded by tests.
  console.warn(`Review Hub: ${message}`);
}

let patched = false;
/** Drop only the node:sqlite experimental notice; every other warning still prints. */
function silenceSqliteWarning(): void {
  if (patched) {
    return;
  }
  patched = true;
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : String((warning as { message?: string } | undefined)?.message ?? "");
    if (text.includes(WARNING_FRAGMENT)) {
      return;
    }
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}

function loadModule(): SqliteModule | undefined {
  try {
    silenceSqliteWarning();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:sqlite") as Partial<SqliteModule>;
    return mod && typeof mod.DatabaseSync === "function" ? (mod as SqliteModule) : undefined;
  } catch {
    return undefined;
  }
}

class Driver implements SqlDriver {
  constructor(private db: DatabaseLike) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    // Rows come back with a null prototype, which breaks deep-equality assertions and
    // any `instanceof` check downstream. Spread every row on the way out.
    return row === undefined || row === null ? undefined : ({ ...(row as Record<string, unknown>) } as T);
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...(row as Record<string, unknown>) }) as T);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the transaction may already be gone
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Open `file`, or return `undefined` when SQLite is unavailable on this runtime. */
export function openDatabase(file: string): SqlDriver | undefined {
  const sqlite = loadModule();
  if (!sqlite) {
    warnOnce("node:sqlite is unavailable on this runtime; using the JSON store.");
    return undefined;
  }
  let db: DatabaseLike;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file, { timeout: 3000 });
  } catch {
    warnOnce("could not open the SQLite store; using the JSON store.");
    return undefined;
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    // The defaults are usable; a read-only filesystem must not stop activation.
  }
  return new Driver(db);
}
