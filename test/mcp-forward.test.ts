import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { HubServer } from "../core/src/hub-server";

const SERVER = path.resolve("dist/mcp-server.cjs");

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Spawn the bundled MCP server and drive it over stdio. */
function spawnMcp(env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const pending = new Map<number, (msg: Rpc) => void>();
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Rpc;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });
  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<Rpc> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 8000);
    });
  };
  const notify = (method: string, params?: unknown) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  return { proc, call, notify };
}

async function init(conn: ReturnType<typeof spawnMcp>) {
  await conn.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  conn.notify("notifications/initialized");
}

test("MCP server forwards propose_edit to a live hub", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "hello world\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "a.txt", old_string: "world", new_string: "there" },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.ok(payload.changeId);
    assert.equal(payload.hunks, 1);
    assert.equal(payload.status, "staged_for_review");
    // Review-then-apply: the edit is staged, not written. `read_file` returns it (see Task 2).
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello world\n");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("MCP server fails fast with a clear error when the hub is down", async () => {
  const conn = spawnMcp({ REVIEW_HUB_URL: "http://127.0.0.1:1", REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: "/tmp" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", { name: "list_changes", arguments: {} });
    const result = res.result as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Review Hub|not running|hub/i);
  } finally {
    conn.proc.kill();
  }
});

test("a relative path routes to the workspace that actually holds it, not the harness cwd", async () => {
  // The reported bug: the harness was launched in project A, but the agent edits project B
  // (which also has a README.md). `process.cwd()` would read A's README — the wrong file.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-"));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-a-"));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-b-"));
  fs.writeFileSync(path.join(projA, "README.md"), "# Project A\n");
  fs.writeFileSync(path.join(projB, "README.md"), "# Project B\n");

  // Both projects are open in the window; B is the one the user is looking at.
  const hub = new HubServer({
    baseDir,
    token: "tok",
    excludeGlobs: [],
    windowStates: () => [
      { pid: process.pid, folders: [projB], activeFile: path.join(projB, "README.md"), focusedAt: 2, updatedAt: 2 },
      { pid: process.pid, folders: [projA], focusedAt: 1, updatedAt: 1 },
    ],
  });
  const addr = await hub.start(0);

  // No REVIEW_HUB_WORKSPACE: the server must work it out. cwd is the repo, not either project.
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", { name: "read_file", arguments: { path: "README.md" } });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.match(payload.content, /Project B/, "reads the focused project's README, not project A's");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("an absolute path routes by containment", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-"));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-a-"));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-b-"));
  fs.mkdirSync(path.join(projA, "src"));
  fs.mkdirSync(path.join(projB, "src"));
  fs.writeFileSync(path.join(projA, "src", "cfg.ts"), "export const who = 'A';\n");
  fs.writeFileSync(path.join(projB, "src", "cfg.ts"), "export const who = 'B';\n");

  const hub = new HubServer({
    baseDir,
    token: "tok",
    excludeGlobs: [],
    windowStates: () => [{ pid: process.pid, folders: [projA, projB], focusedAt: 1, updatedAt: 1 }],
  });
  const addr = await hub.start(0);
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: path.join(projB, "src", "cfg.ts") },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.match(payload.content, /'B'/, "the absolute path picks project B");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("propose_edit adapts CRLF/LF line endings gracefully", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-eol-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-eol-"));
  fs.writeFileSync(path.join(workspace, "crlf.txt"), "line 1\r\nline 2\r\nline 3\r\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "crlf.txt", old_string: "line 2\n", new_string: "line 2 modified\n" },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.equal(payload.status, "staged_for_review");
    assert.equal(payload.hunks, 1);

    const readRes = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "crlf.txt" },
    });
    const readPayload = JSON.parse((readRes.result as { content: { text: string }[] }).content[0].text);
    assert.match(readPayload.content, /line 2 modified/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});


test("propose_edit adapts indentation differences (fuzzy matching)", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-fuzzy-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-fuzzy-"));
  // File has 4 spaces indentation
  const fileContent = "function test() {\n    if (ok) {\n        return 1;\n    }\n}\n";
  fs.writeFileSync(path.join(workspace, "code.ts"), fileContent);
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    // LLM sends 2 spaces indentation
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: {
        path: "code.ts",
        old_string: "if (ok) {\n  return 1;\n}",
        new_string: "if (ok) {\n  return 42;\n}",
      },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.equal(payload.status, "staged_for_review");
    assert.equal(payload.hunks, 1);

    const readRes = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "code.ts" },
    });
    const readPayload = JSON.parse((readRes.result as { content: { text: string }[] }).content[0].text);
    // Should adapt to 4 spaces indentation!
    assert.match(readPayload.content, /        return 42;/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("propose_edit tolerates trailing whitespace in file (fuzzy matching)", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-trailing-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-trailing-"));
  // File has trailing spaces
  fs.writeFileSync(path.join(workspace, "trailing.txt"), "const x = 1;   \nconst y = 2;  \n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    // LLM sends clean strings without trailing spaces
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: {
        path: "trailing.txt",
        old_string: "const x = 1;\nconst y = 2;",
        new_string: "const x = 100;\nconst y = 200;",
      },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.equal(payload.status, "staged_for_review");

    const readRes = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "trailing.txt" },
    });
    const readPayload = JSON.parse((readRes.result as { content: { text: string }[] }).content[0].text);
    assert.match(readPayload.content, /const x = 100;\nconst y = 200;/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("read_file supports start_line, end_line, and line_numbers", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-read-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-read-"));
  fs.writeFileSync(path.join(workspace, "lines.txt"), "A\nB\nC\nD\nE\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "lines.txt", start_line: 2, end_line: 4, line_numbers: true },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.equal(payload.total_lines, 6);
    assert.equal(payload.start_line, 2);
    assert.equal(payload.end_line, 4);
    assert.match(payload.content, /2 \| B/);
    assert.match(payload.content, /3 \| C/);
    assert.match(payload.content, /4 \| D/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("get_change returns detailed hunks and unified diff", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-diff-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-diff-"));
  fs.writeFileSync(path.join(workspace, "code.ts"), "const x = 1;\nconst y = 2;\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "code.ts", old_string: "const x = 1;\n", new_string: "const x = 100;\n" },
    });
    const res = await conn.call("tools/call", {
      name: "get_change",
      arguments: { path: "code.ts" },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.equal(payload.path, "code.ts");
    assert.equal(payload.hunksCount, 1);
    assert.ok(payload.hunks[0].id);
    assert.match(payload.diff, /-const x = 1;/);
    assert.match(payload.diff, /\+const x = 100;/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("checkpoint tools (get_checkpoint, clear_checkpoint) and list_workspaces work", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-cp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-cp-"));
  fs.writeFileSync(path.join(workspace, "f.txt"), "foo\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const cpRes = await conn.call("tools/call", { name: "get_checkpoint", arguments: {} });
    const cpPayload = JSON.parse((cpRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(cpPayload.checkpoint);
    assert.equal(cpPayload.checkpoint.files, 1);

    const wsRes = await conn.call("tools/call", { name: "list_workspaces", arguments: {} });
    const wsPayload = JSON.parse((wsRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(Array.isArray(wsPayload.workspaces));

    const clearRes = await conn.call("tools/call", { name: "clear_checkpoint", arguments: {} });
    const clearPayload = JSON.parse((clearRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(clearPayload.ok === true || clearPayload.cleared === true);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("resources and prompts are registered and callable", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-rp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-rp-"));
  fs.writeFileSync(path.join(workspace, "r.txt"), "resource test\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const resList = await conn.call("resources/list", {});
    const rList = resList.result as { resources: Array<{ uri: string }> };
    assert.ok(rList.resources.some((r) => r.uri === "review-hub://changes"));

    const promptList = await conn.call("prompts/list", {});
    const pList = promptList.result as { prompts: Array<{ name: string }> };
    assert.ok(pList.prompts.some((p) => p.name === "review_pending_changes"));
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("get_change_status returns accurate pending and resolved metrics", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-status-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-status-"));
  fs.writeFileSync(path.join(workspace, "status.txt"), "hello world\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const propRes = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "status.txt", old_string: "hello world", new_string: "hello review-hub" },
    });
    const propPayload = JSON.parse((propRes.result as { content: { text: string }[] }).content[0].text);
    const changeId = propPayload.changeId as string;

    const statusRes = await conn.call("tools/call", {
      name: "get_change_status",
      arguments: { changeId },
    });
    const statusPayload = JSON.parse((statusRes.result as { content: { text: string }[] }).content[0].text);
    assert.equal(statusPayload.changeId, changeId);
    assert.equal(statusPayload.overallStatus, "pending");
    assert.equal(statusPayload.isFullyResolved, false);
    assert.equal(statusPayload.hunks.pending, 1);
    assert.equal(statusPayload.hunks.accepted, 0);

    // Accept and check resolved status
    await conn.call("tools/call", {
      name: "accept",
      arguments: { changeId },
    });

    const resolvedRes = await conn.call("tools/call", {
      name: "get_change_status",
      arguments: { changeId },
    });
    const resolvedPayload = JSON.parse((resolvedRes.result as { content: { text: string }[] }).content[0].text);
    assert.equal(resolvedPayload.overallStatus, "resolved");
    assert.equal(resolvedPayload.isFullyResolved, true);
    assert.equal(resolvedPayload.hunks.pending, 0);
    assert.equal(resolvedPayload.hunks.accepted, 1);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});
