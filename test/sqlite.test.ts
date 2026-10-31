import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../core/src/sqlite";

function dbFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sql-")), "hub.db");
}

test("openDatabase creates the file and its directory", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sql-")), "nested", "hub.db");
  const db = openDatabase(file);
  assert.ok(db, "node:sqlite must be available on Node 22.13+");
  db!.close();
  assert.ok(fs.existsSync(file));
});

test("schema, upsert and read round-trip", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, flag INTEGER NOT NULL)");
    db.run("INSERT INTO t (id, n, flag) VALUES (?, ?, ?)", "a", 1, Number(true));
    db.run("INSERT OR REPLACE INTO t (id, n, flag) VALUES (?, ?, ?)", "a", 2, Number(false));
    const row = db.get<{ id: string; n: number; flag: number }>("SELECT * FROM t WHERE id = ?", "a");
    assert.deepEqual({ ...row! }, { id: "a", n: 2, flag: 0 });
    assert.equal(db.all<{ id: string }>("SELECT id FROM t").length, 1);
  } finally {
    db.close();
  }
});

test("rows come back as plain objects, spread out of the null-prototype row", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    db.run("INSERT INTO t (id) VALUES (?)", "a");
    const row = db.get<{ id: string }>("SELECT * FROM t")!;
    // The driver spreads every row on the way out, so the value the caller sees has
    // Object.prototype (unlike the raw node:sqlite row, which has a null prototype and
    // would fail the deep-equality assertion below).
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.deepEqual(row, { id: "a" });
  } finally {
    db.close();
  }
});

test("a boolean cannot be bound, so it is stored as 0/1", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (flag INTEGER NOT NULL)");
    try { db.run("INSERT INTO t (flag) VALUES (?)", true); } catch (err: unknown) { assert.match(String(err), /cannot be bound/); }
    db.run("INSERT INTO t (flag) VALUES (?)", Number(true));
    assert.equal(db.get<{ flag: number }>("SELECT flag FROM t")!.flag, 1);
  } finally {
    db.close();
  }
});

test("ON DELETE CASCADE removes the child rows", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE child (id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE)");
    db.run("INSERT INTO parent (id) VALUES (?)", "p");
    db.run("INSERT INTO child (id) VALUES (?)", "p");
    db.run("INSERT INTO child (id) VALUES (?)", "p");
    assert.equal(db.all("SELECT id FROM child").length, 2);
    db.run("DELETE FROM parent WHERE id = ?", "p");
    assert.equal(db.all("SELECT id FROM child").length, 0);
  } finally {
    db.close();
  }
});

test("transaction rolls back on a throw and commits on success", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (id) VALUES (?)", "a");
        throw new Error("boom");
      }),
    );
    assert.equal(db.all("SELECT id FROM t").length, 0, "the rolled-back row is gone");
    db.transaction(() => db.run("INSERT INTO t (id) VALUES (?)", "b"));
    assert.equal(db.all("SELECT id FROM t").length, 1);
  } finally {
    db.close();
  }
});

test("a second connection on the same file sees the first one's committed rows", () => {
  const file = dbFile();
  const a = openDatabase(file)!;
  const b = openDatabase(file)!;
  try {
    a.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    a.run("INSERT INTO t (id) VALUES (?)", "from-a");
    assert.equal(b.all<{ id: string }>("SELECT id FROM t").length, 1, "b sees a's commit");
    b.run("INSERT INTO t (id) VALUES (?)", "from-b");
    assert.equal(a.all<{ id: string }>("SELECT id FROM t").length, 2, "a sees b's commit");
  } finally {
    a.close();
    b.close();
  }
});

test("journal_mode is WAL and busy_timeout is set", () => {
  const db = openDatabase(dbFile())!;
  try {
    assert.equal(String(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toLowerCase(), "wal");
    assert.equal(Number(db.get<{ timeout: number }>("PRAGMA busy_timeout")!.timeout), 3000);
    assert.equal(Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys), 1);
  } finally {
    db.close();
  }
});
