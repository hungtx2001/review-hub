import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubServer } from "../core/src/hub-server";

async function hubOn(workspace: string, content: string) {
  fs.writeFileSync(path.join(workspace, "a.txt"), content);
  const hub = new HubServer({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-")), token: "t", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });
  const call = async (p: string, method = "GET", body?: unknown) => {
    const url = new URL(addr.url + p);
    const res = await fetch(url, {
      method,
      headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as Promise<any>;
  };
  return { hub, addr, call, workspace };
}

test("/file/read returns the staged content, not the disk", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-ws-"));
  const { hub, call } = await hubOn(workspace, "hello world\n");
  try {
    await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "hello there\n" });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "hello there\n", "the hub reports the staged content");
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello world\n", "the disk is untouched");
  } finally {
    await hub.stop();
  }
});

test("two sequential edits both succeed because the second sees the first", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-seq-"));
  const { hub, call } = await hubOn(workspace, "alpha\nbeta\n");
  try {
    await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "ALPHA\nbeta\n" });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.match(read.content, /^ALPHA/, "the first staged edit is visible to the second");
  } finally {
    await hub.stop();
  }
});

test("an absolute in-workspace path reads the staged content too", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-abs-"));
  const { hub, call } = await hubOn(workspace, "alpha\nbeta\n");
  try {
    const absPath = path.join(workspace, "a.txt");
    await call("/changes/propose", "POST", { workspace, path: absPath, content: "ALPHA\nbeta\n" });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(absPath)}`);
    assert.equal(read.content, "ALPHA\nbeta\n", "an absolute path resolves to the staged change");
    assert.equal(read.staged, true, "the staged branch is taken for an absolute path");
  } finally {
    await hub.stop();
  }
});

test("a rejected hunk is not part of the staged content", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-rej-"));
  const { hub, call } = await hubOn(workspace, "one\ntwo\nthree\n");
  try {
    const proposed = await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "one\nTWO\nthree\n" });
    await call("/changes/reject", "POST", { changeId: proposed.changeId });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "one\ntwo\nthree\n", "a rejected hunk reads as baseline");
  } finally {
    await hub.stop();
  }
});

test("an accepted hunk is part of the staged content", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-acc-"));
  const { hub, call } = await hubOn(workspace, "one\ntwo\nthree\n");
  try {
    const proposed = await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "one\nTWO\nthree\n" });
    await call("/changes/accept", "POST", { changeId: proposed.changeId, hunkIds: [proposed.hunks[0].id] });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "one\nTWO\nthree\n");
  } finally {
    await hub.stop();
  }
});
