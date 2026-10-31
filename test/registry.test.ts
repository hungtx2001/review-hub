import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRegistry, pidAlive } from "../core/src/registry";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
}

test("write then read round-trips", () => {
  const reg = createRegistry(tmp());
  reg.writeEntry({ url: "http://127.0.0.1:1", token: "t", pid: process.pid, workspace: "/w", updatedAt: Date.now(), protocol: 1 });
  const entry = reg.readEntry();
  assert.equal(entry?.url, "http://127.0.0.1:1");
  assert.equal(entry?.token, "t");
});

test("corrupt registry file reads as undefined", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "hub.json"), "{not json");
  const reg = createRegistry(dir);
  assert.equal(reg.readEntry(), undefined);
});

test("lock is mutually exclusive", async () => {
  const dir = tmp();
  const a = createRegistry(dir);
  const b = createRegistry(dir);
  const order: string[] = [];
  let bPromise: Promise<void> = Promise.resolve();
  await a.withLock(async () => {
    order.push("a-start");
    // b starts while a holds the lock; it must block until a releases.
    bPromise = b.withLock(async () => {
      order.push("b");
    });
    await new Promise((r) => setTimeout(r, 300));
    order.push("a-end");
  });
  await bPromise;
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("stale lock is stolen", async () => {
  const dir = tmp();
  const lockPath = path.join(dir, "hub.lock");
  fs.writeFileSync(lockPath, "999999");
  // backdate the lock beyond the stale threshold
  const old = new Date(Date.now() - 300_000);
  fs.utimesSync(lockPath, old, old);
  const reg = createRegistry(dir);
  let ran = false;
  await reg.withLock(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("pidAlive is false for a nonexistent pid", () => {
  assert.equal(pidAlive(999999999), false);
  assert.equal(pidAlive(process.pid), true);
});
