import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubServer } from "../core/src/hub-server";

/**
 * End-to-end: the two paths a real agent can take, verified against one hub.
 * 1. MCP path — stage an edit, nothing on disk, accept writes it.
 * 2. FS path — an agent ignores the MCP and writes directly; reject restores the
 *    baseline lines for just the rejected hunk.
 */
test("e2e: staged edit accepted, direct write hunk-rejected", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-e2e-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-e2e-ws-"));
  const file = path.join(workspace, "app.js");
  fs.writeFileSync(file, "function add(a, b) {\n  return a + b;\n}\n");

  const hub = new HubServer({ baseDir, token: "e2e", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(addr.url + p, {
      method,
      headers: { authorization: "Bearer e2e", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as Promise<any>;
  };

  try {
    // --- Path 1: MCP propose ---
    const proposed = await api("POST", "/changes/propose", {
      workspace,
      path: "app.js",
      content: "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n",
    });
    assert.equal(proposed.hunks.length, 1);
    // Review-then-apply: staging must NOT touch the file.
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /function sub/, "not applied on propose");

    await api("POST", "/changes/accept", { changeId: proposed.changeId });
    assert.match(fs.readFileSync(file, "utf8"), /function sub/, "accepted edit kept");

    // checkpoint the accepted state
    await api("POST", "/checkpoint/set", { workspace });

    // --- Path 2: agent writes directly, user rejects one of two hunks ---
    fs.writeFileSync(file, "function add(a, b) {\n  return a + b + 0;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n");
    const observed = await api("POST", "/changes/observe", { workspace, path: "app.js" });
    assert.equal(observed.applied, true);
    assert.equal(observed.hunks.length, 1);

    await api("POST", "/changes/reject", { changeId: observed.changeId });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n",
      "rejected hunk restored to baseline",
    );

    // list is empty once everything is resolved
    const list = await api("GET", `/changes/list?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(list.files.length, 0);
  } finally {
    await hub.stop();
  }
});
