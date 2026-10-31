import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonBackend, SqliteBackend, type StoreBackend } from "../core/src/store-backend";
import { encodeBaseline, isEncodedBaseline } from "../core/src/file-snapshot";
import { openDatabase } from "../core/src/sqlite";
import type { ChangeSet } from "../core/src/types";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-be-"));
}

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "mcp",
    applied: false,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "one\ntwo\n",
    proposed: "one\nTWO\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [
      {
        id: "h1",
        oldStart: 1,
        oldLines: ["two"],
        newStart: 1,
        newLines: ["TWO"],
        decision: "pending",
      },
    ],
    status: "pending",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

/** Every assertion in this file runs against each backend, so they cannot drift. */
function eachBackend(run: (name: string, make: () => StoreBackend) => void): void {
  run("JsonBackend", () => new JsonBackend(tmp()));
  run("SqliteBackend", () => {
    const dir = tmp();
    const driver = openDatabase(path.join(dir, "hub.db"));
    assert.ok(driver, "node:sqlite must be available for the SQLite backend test");
    return new SqliteBackend(driver!);
  });
}

eachBackend((name, make) => {
  test(`[${name}] change round-trip keeps its hunks`, () => {
    const backend = make();
    const cs = changeSet();
    backend.writeChange(cs);
    const got = backend.getChange("/ws", "c1");
    assert.ok(got);
    assert.equal(got!.path, "a.txt");
    assert.equal(got!.applied, false);
    assert.equal(got!.hunks.length, 1);
    assert.deepEqual(got!.hunks[0].newLines, ["TWO"]);
    assert.equal(got!.hunks[0].decision, "pending");
    backend.dispose();
  });

  test(`[${name}] resolved sets are hidden from the list but still readable by id`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.writeChange(changeSet({ id: "c2", path: "b.txt", status: "resolved" }));
    assert.deepEqual(backend.listChangeSets("/ws").map((c) => c.path), ["a.txt"]);
    assert.equal(backend.findById("c2")?.status, "resolved");
    backend.dispose();
  });

  test(`[${name}] findChangeByPath ignores a resolved set`, () => {
    const backend = make();
    backend.writeChange(changeSet({ status: "resolved" }));
    assert.equal(backend.findChangeByPath("/ws", "a.txt"), undefined);
    backend.dispose();
  });

  test(`[${name}] removeChange drops the change and its hunks`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.removeChange("/ws", "c1");
    assert.equal(backend.getChange("/ws", "c1"), undefined);
    assert.equal(backend.findById("c1"), undefined);
    backend.dispose();
  });

  test(`[${name}] listChangeSets is scoped to one workspace`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.writeChange(changeSet({ id: "c2", workspace: "/other", path: "a.txt" }));
    assert.equal(backend.listChangeSets("/ws").length, 1);
    assert.equal(backend.listChangeSets("/other").length, 1);
    backend.dispose();
  });

  test(`[${name}] checkpoint round-trip and clear`, () => {
    const backend = make();
    assert.equal(backend.readCheckpoint("/ws"), undefined);
    backend.writeCheckpoint({ workspace: "/ws", setAt: 5, files: { "a.txt": "abc" } });
    const cp = backend.readCheckpoint("/ws");
    assert.equal(cp?.setAt, 5);
    assert.deepEqual(cp?.files, { "a.txt": "abc" });
    assert.deepEqual(backend.knownWorkspaces(), ["/ws"]);
    backend.clearCheckpoint("/ws");
    assert.equal(backend.readCheckpoint("/ws"), undefined);
    backend.dispose();
  });

  test(`[${name}] clearCheckpoint also drops the workspace's changes`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.clearCheckpoint("/ws");
    assert.equal(backend.listChangeSets("/ws").length, 0);
    backend.dispose();
  });

  test(`[${name}] pruneResolved drops only stale resolved sets`, () => {
    const backend = make();
    backend.writeChange(changeSet({ id: "c2", path: "b.txt", status: "resolved", updatedAt: 1 }));
    backend.writeChange(changeSet({ id: "c3", path: "c.txt", status: "resolved", updatedAt: Date.now() }));
    backend.writeChange(changeSet({ id: "c1", path: "a.txt" }));
    backend.pruneResolved(1000);
    assert.equal(backend.findById("c2"), undefined, "the stale resolved set is gone");
    assert.ok(backend.findById("c3"), "a fresh resolved set is kept");
    assert.ok(backend.findById("c1"), "a pending set is never pruned");
    backend.dispose();
  });

  test(`[${name}] baselines are content-addressed and readable back`, () => {
    const backend = make();
    const hash = backend.putBaseline("/ws", "hello\n");
    assert.equal(backend.putBaseline("/ws", "hello\n"), hash, "the same content gives the same hash");
    assert.equal(backend.getBaseline("/ws", hash), "hello\n");
    assert.equal(backend.getBaseline("/ws", "missing"), "");
    backend.dispose();
  });

  test(`[${name}] baselineB64 round-trips through the backend`, () => {
    const backend = make();
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41]);
    // A binary set declares its baseline encoding explicitly...
    backend.writeChange(
      changeSet({
        id: "bin1",
        path: "blob.bin",
        binary: true,
        baseline: encodeBaseline(bytes),
        baselineB64: true,
      }),
    );
    const bin = backend.getChange("/ws", "bin1");
    assert.ok(bin);
    assert.equal(bin!.baselineB64, true, "the base64 encoding survives the round-trip");

    // ...and a plain utf8 baseline reports false, not undefined.
    backend.writeChange(changeSet({ id: "txt1", path: "a.txt", baselineB64: false }));
    const txt = backend.getChange("/ws", "txt1");
    assert.ok(txt);
    assert.equal(txt!.baselineB64, false, "a plain baseline round-trips as false");

    // A hand-built set that OMITS the field must still reach the same encoding decision on
    // both backends: the SQLite column persists `false`, JSON leaves it absent, and the
    // `?? isEncodedBaseline` fallback collapses both to the same answer.
    backend.writeChange(
      changeSet({ id: "omit1", path: "raw.bin", binary: true, baseline: "plain text\n" }),
    );
    const omit = backend.getChange("/ws", "omit1");
    assert.ok(omit);
    assert.equal(
      omit!.baselineB64 ?? isEncodedBaseline(omit!.baseline),
      false,
      "an omitted flag resolves to 'raw' on both backends for a prefix-free baseline",
    );
    backend.dispose();
  });
});
