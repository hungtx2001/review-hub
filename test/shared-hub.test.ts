import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";
import { createRegistry, pidAlive } from "../core/src/registry";
import { HubServer } from "../core/src/hub-server";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-shared-"));
}

function wsWithFile(name = "a.txt", content = "one\ntwo\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ws-"));
  fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("one store serves many workspaces independently", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const wsA = wsWithFile();
  const wsB = wsWithFile("b.txt", "alpha\nbeta\n");

  await store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });

  store.propose(wsA, "a.txt", "one\nTWO\n");
  store.propose(wsB, "b.txt", "alpha\nBETA\n");

  const a = store.listChanges(wsA);
  const b = store.listChanges(wsB);
  assert.equal(a.length, 1);
  assert.equal(a[0].path, "a.txt");
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "b.txt");

  // Accepting in one workspace must not touch the other.
  store.accept(a[0].id);
  assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one\nTWO\n");
  assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\nbeta\n", "wsB is untouched");
  assert.equal(store.listChanges(wsB).length, 1, "wsB change is untouched");
});

test("listKnownWorkspaces reports every workspace with state", async () => {
  const baseDir = tmp();
  const store = new ChangeStore({ baseDir });
  const wsA = wsWithFile();
  const wsB = wsWithFile("b.txt", "x\n");

  await store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });
  store.propose(wsA, "a.txt", "one\nTWO\n");

  const known = store.listKnownWorkspaces();
  assert.ok(known.includes(wsA), "wsA should be listed");
  assert.ok(known.includes(wsB), "wsB should be listed");
});

test("a second store instance sees the first one's changes (shared file-backed state)", async () => {
  const baseDir = tmp();
  const ws = wsWithFile();
  const storeA = new ChangeStore({ baseDir });
  await storeA.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  storeA.propose(ws, "a.txt", "one\nTWO\n");

  // A different process/window would construct its own store over the same baseDir.
  const storeB = new ChangeStore({ baseDir });
  const seen = storeB.listChanges(ws);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "a.txt");
  assert.equal(seen[0].pending, 1);

  // Deciding in B is visible to A (cache revalidates by directory mtime).
  storeB.accept(seen[0].id);
  assert.equal(storeA.listChanges(ws).length, 0, "A sees the resolution made in B");
});

test("host election: first window wins, a live host is not stolen", async () => {
  const baseDir = tmp();
  const reg = createRegistry(baseDir);

  // A live host owned by a *different* process (pid 1 is always alive on Linux).
  reg.writeEntry({ url: "http://127.0.0.1:1", token: "t1", pid: process.ppid, workspace: "/a", updatedAt: Date.now(), protocol: 1 });

  // Our window checks: a live host exists, so it must NOT take over.
  let becameHost = false;
  await reg.withLock(async () => {
    const existing = reg.readEntry();
    if (!(existing && existing.pid !== process.pid && pidAlive(existing.pid))) {
      becameHost = true;
      reg.writeEntry({ url: "http://127.0.0.1:2", token: "t2", pid: process.pid, workspace: "/b", updatedAt: Date.now(), protocol: 1 });
    }
  });
  assert.equal(becameHost, false, "window 2 must not steal a live host");
  assert.equal(reg.readEntry()?.token, "t1", "registry still points at the original host");
});

test("host election: a dead host is replaced", async () => {
  const baseDir = tmp();
  const reg = createRegistry(baseDir);
  // A stale entry whose pid is not alive.
  reg.writeEntry({ url: "http://127.0.0.1:1", token: "dead", pid: 999999999, workspace: "/a", updatedAt: Date.now(), protocol: 1 });

  let becameHost = false;
  await reg.withLock(async () => {
    const existing = reg.readEntry();
    if (!(existing && existing.pid !== process.pid && pidAlive(existing.pid))) {
      becameHost = true;
      reg.writeEntry({ url: "http://127.0.0.1:2", token: "new", pid: process.pid, workspace: "/b", updatedAt: Date.now(), protocol: 1 });
    }
  });
  assert.equal(becameHost, true, "a dead host must be replaced");
  assert.equal(reg.readEntry()?.token, "new");
});

test("one hub serves proposes for two different workspaces", async () => {
  const baseDir = tmp();
  const hub = new HubServer({ baseDir, token: "t", excludeGlobs: [] });
  const addr = await hub.start(0);
  const wsA = wsWithFile();
  const wsB = wsWithFile("b.txt", "alpha\nbeta\n");
  await hub.store.setCheckpoint(wsA, { maxFileSize: 1e9, excludeGlobs: [] });
  await hub.store.setCheckpoint(wsB, { maxFileSize: 1e9, excludeGlobs: [] });

  const call = async (p: string, body: unknown) => {
    const res = await fetch(addr.url + p, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  try {
    await call("/changes/propose", { workspace: wsA, path: "a.txt", content: "one\nTWO\n" });
    await call("/changes/propose", { workspace: wsB, path: "b.txt", content: "alpha\nBETA\n" });

    const listA = (await (await fetch(`${addr.url}/changes/list?workspace=${encodeURIComponent(wsA)}`, {
      headers: { authorization: "Bearer t" },
    })).json()) as { files: unknown[] };
    const listB = (await (await fetch(`${addr.url}/changes/list?workspace=${encodeURIComponent(wsB)}`, {
      headers: { authorization: "Bearer t" },
    })).json()) as { files: unknown[] };

    assert.equal(listA.files.length, 1);
    assert.equal(listB.files.length, 1);
    assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one\ntwo\n");
    assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\nbeta\n");
  } finally {
    await hub.stop();
  }
});
