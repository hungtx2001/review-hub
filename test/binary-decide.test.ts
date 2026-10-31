import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ChangeStore } from "../core/src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-bin-"));
}

/** Same pattern as test/git-baseline.test.ts: a throwaway repo with an initial commit. */
function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return dir;
}

const COMMITTED = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41]);
const AGENT_BYTES = Buffer.from([0x00, 0x09, 0x09, 0x7f, 0x00, 0x42, 0x43]);

function committedBinaryRepo(): { ws: string; file: string } {
  const ws = gitRepo();
  const file = path.join(ws, "blob.bin");
  fs.writeFileSync(file, COMMITTED);
  execFileSync("git", ["add", "blob.bin"], { cwd: ws, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ws, stdio: "pipe" });
  // Overwrite on disk without committing: the agent's direct write.
  fs.writeFileSync(file, AGENT_BYTES);
  return { ws, file };
}

test("reject of a git-tracked binary restores the committed bytes and stops re-reporting", async () => {
  const { ws, file } = committedBinaryRepo();
  const store = new ChangeStore({ baseDir: tmp() });

  const cs = await store.observe(ws, "blob.bin");
  assert.ok(cs, "the changed binary is reported");
  assert.equal(cs!.binary, true, "a NUL byte routes the file to the binary path");

  const r = store.reject(cs!.id);
  assert.equal(r.resolved, true);
  assert.deepEqual(fs.readFileSync(file), COMMITTED, "the committed bytes are restored byte-for-byte");
  assert.equal(await store.observe(ws, "blob.bin"), undefined, "the rejected binary must not reappear");
  assert.equal(store.listChanges(ws).length, 0);
});

test("accept of a git-tracked binary keeps the agent's bytes and stops re-reporting", async () => {
  const { ws, file } = committedBinaryRepo();
  const store = new ChangeStore({ baseDir: tmp() });

  const cs = await store.observe(ws, "blob.bin");
  assert.ok(cs, "the changed binary is reported");
  assert.equal(cs!.binary, true);

  const r = store.accept(cs!.id);
  assert.equal(r.resolved, true);
  assert.deepEqual(fs.readFileSync(file), AGENT_BYTES, "accept keeps the bytes already on disk");
  assert.equal(await store.observe(ws, "blob.bin"), undefined, "the accepted binary must not reappear");
  assert.equal(store.listChanges(ws).length, 0);
});

test("reject of an oversize text file restores the original text exactly", async () => {
  const ws = tmp();
  const file = path.join(ws, "big.txt");
  const original = "line one\nline two\nline three\n";
  fs.writeFileSync(file, original);

  const baseDir = tmp();
  // Baseline the file while it is still small enough for the store to read it.
  const big = new ChangeStore({ baseDir });
  await big.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  const agentText = "agent line one\nagent line two\n";
  fs.writeFileSync(file, agentText);

  // A second store over the same baseDir with a tiny limit: the file is now "too large
  // to line-diff", so it takes the binary/oversize path over the plain-utf8 baseline.
  const small = new ChangeStore({ baseDir, maxFileSize: 8 });
  const cs = await small.observe(ws, "big.txt");
  assert.ok(cs, "the oversize change is reported");
  assert.equal(cs!.binary, true, "an oversize text file uses the binary/oversize path");

  const r = small.reject(cs!.id);
  assert.equal(r.resolved, true);
  assert.equal(fs.readFileSync(file, "utf8"), original, "the original text is restored exactly");
  assert.equal(await small.observe(ws, "big.txt"), undefined, "the rejected file must not reappear");
});

test("reject of a new binary with no baseline deletes it", async () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  // A checkpoint that does not mention the file, in a non-git directory -> no baseline.
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  const file = path.join(ws, "new.bin");
  fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));

  const cs = await store.observe(ws, "new.bin");
  assert.ok(cs, "the new binary is reported");
  assert.equal(cs!.binary, true);
  assert.equal(cs!.baselineExists, false, "a file created after the checkpoint has no baseline");

  store.reject(cs!.id);
  assert.equal(fs.existsSync(file), false, "a rejected new binary is removed from disk");
  assert.equal(await store.observe(ws, "new.bin"), undefined, "the deleted binary must not reappear");
});
