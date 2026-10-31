import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubServer } from "../core/src/hub-server";

async function startHub() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-hub-"));
  const hub = new HubServer({ baseDir, token: "test-token", excludeGlobs: [] });
  const addr = await hub.start(0);
  return { hub, addr, baseDir };
}

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-ws-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  return dir;
}

async function api(addr: { url: string; token: string }, method: string, p: string, body?: unknown) {
  const res = await fetch(addr.url + p, {
    method,
    headers: { authorization: `Bearer ${addr.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test("rejects requests without a token", async () => {
  const { hub, addr } = await startHub();
  try {
    const res = await fetch(addr.url + "/healthz");
    assert.equal(res.status, 401);
  } finally {
    await hub.stop();
  }
});

test("rejects browser-originated requests (Origin header)", async () => {
  const { hub, addr } = await startHub();
  try {
    const res = await fetch(addr.url + "/healthz", {
      headers: { authorization: `Bearer ${addr.token}`, origin: "http://evil.example" },
    });
    assert.equal(res.status, 401);
  } finally {
    await hub.stop();
  }
});

test("healthz works with a token", async () => {
  const { hub, addr } = await startHub();
  try {
    const r = await api(addr, "GET", "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally {
    await hub.stop();
  }
});

test("propose -> list -> accept round-trip", async () => {
  const { hub, addr } = await startHub();
  const workspace = ws();
  try {
    await api(addr, "POST", "/checkpoint/set", { workspace });
    const proposed = await api(addr, "POST", "/changes/propose", { workspace, path: "a.txt", content: "one\nTWO\n" });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.json.hunks.length, 1);

    const list = await api(addr, "GET", `/changes/list?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(list.json.files.length, 1);
    assert.equal(list.json.files[0].path, "a.txt");

    const accepted = await api(addr, "POST", "/changes/accept", { changeId: proposed.json.changeId });
    assert.equal(accepted.json.resolved, true);
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "one\nTWO\n");
  } finally {
    await hub.stop();
  }
});

test("unknown change id returns 404", async () => {
  const { hub, addr } = await startHub();
  try {
    const r = await api(addr, "GET", "/changes/get?changeId=deadbeef");
    assert.equal(r.status, 404);
  } finally {
    await hub.stop();
  }
});

test("bad JSON body returns 400", async () => {
  const { hub, addr } = await startHub();
  try {
    const res = await fetch(addr.url + "/changes/propose", {
      method: "POST",
      headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await hub.stop();
  }
});

test("path escaping the workspace is refused", async () => {
  const { hub, addr } = await startHub();
  const workspace = ws();
  try {
    await api(addr, "POST", "/checkpoint/set", { workspace });
    const r = await api(addr, "POST", "/changes/propose", { workspace, path: "../evil.txt", content: "x" });
    assert.equal(r.status, 400);
  } finally {
    await hub.stop();
  }
});
