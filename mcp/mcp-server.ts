/**
 * Thin stdio MCP server. Harnesses (Claude Code, opencode, dsh, Cline, Roo) spawn
 * this per session; it forwards every tool call to the Review Hub HTTP server run by
 * the VS Code extension or JetBrains plugin, discovered via ~/.review-hub/hub.json.
 *
 * It never edits files itself. If the hub is not running it fails fast with a clear
 * message so the agent falls back to native tools (whose writes the FS watcher still
 * catches). It must never hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRegistry, defaultBaseDir, pidAlive } from "../core/src/registry";
import type { HubEntry } from "../core/src/registry";
import type { ChangeSet, Hunk } from "../core/src/types";

interface HubTarget {
  url: string;
  token: string;
  /** The workspace the hub is serving, used only as a last-resort fallback. */
  workspace?: string;
}

function resolveTarget(): HubTarget | null {
  const envUrl = process.env.REVIEW_HUB_URL;
  const envToken = process.env.REVIEW_HUB_TOKEN;
  if (envUrl && envToken) {
    return { url: envUrl.replace(/\/$/, ""), token: envToken };
  }
  const entry: HubEntry | undefined = createRegistry(process.env.REVIEW_HUB_DIR ?? defaultBaseDir()).readEntry();
  if (!entry) {
    return null;
  }
  if (!pidAlive(entry.pid)) {
    return null;
  }
  return { url: entry.url.replace(/\/$/, ""), token: entry.token, workspace: entry.workspace };
}

async function callHub<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const target = resolveTarget();
  if (!target) {
    throw new Error(
      "Review Hub is not running. Open Review Hub in VS Code or JetBrains IDE, start the standalone daemon (node dist/hub-server.cjs), or fall back to native tools (file watcher will capture direct writes).",
    );
  }
  const url = new URL(target.url + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = parsed?.error?.message ?? `hub returned ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") {
      throw new Error("Review Hub did not respond in time. Is the IDE window or Hub daemon still running?");
    }
    if (e?.message === "fetch failed" || e?.name === "TypeError") {
      throw new Error(
        "Review Hub is not reachable. Open Review Hub in VS Code or JetBrains IDE, start the standalone daemon, or fall back to your normal edit tools (the file watcher still records those changes).",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which project this agent is working in.
 */
let workspaceCache: { at: number; list: string[] } | undefined;
let stickyWorkspace: string | undefined;

async function hubWorkspaces(): Promise<string[]> {
  const now = Date.now();
  if (workspaceCache && now - workspaceCache.at < 2000) {
    return workspaceCache.list;
  }
  try {
    const res = await callHub<{ workspaces: string[] }>("/workspaces");
    workspaceCache = { at: now, list: res.workspaces ?? [] };
  } catch {
    workspaceCache = { at: now, list: [] };
  }
  return workspaceCache.list;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `p` is `root` or sits inside it, case-insensitive on Windows. */
function isInside(root: string, p: string): boolean {
  const isWin = process.platform === "win32";
  const r = normalizePath(root);
  const target = normalizePath(p);
  const compR = isWin ? r.toLowerCase() : r;
  const compTarget = isWin ? target.toLowerCase() : target;
  return compTarget === compR || compTarget.startsWith(compR + "/");
}

async function resolveWorkspace(path?: string): Promise<string> {
  const explicit = process.env.REVIEW_HUB_WORKSPACE;
  if (explicit) {
    return explicit;
  }
  const known = await hubWorkspaces();
  if (path) {
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
      const hit = known.filter((ws) => isInside(ws, path)).sort((a, b) => b.length - a.length)[0];
      if (hit) {
        stickyWorkspace = hit;
        return hit;
      }
    } else {
      if (stickyWorkspace) {
        try {
          const probe = await callHub<{ exists: boolean }>("/file/read", {
            query: { workspace: stickyWorkspace, path },
          });
          if (probe.exists) {
            return stickyWorkspace;
          }
        } catch {
          // fall through to a full probe
        }
      }
      for (const ws of known) {
        try {
          const probe = await callHub<{ exists: boolean }>("/file/read", { query: { workspace: ws, path } });
          if (probe.exists) {
            stickyWorkspace = ws;
            return ws;
          }
        } catch {
          // try the next workspace
        }
      }
    }
  }
  const cwd = process.cwd();
  const isWin = process.platform === "win32";
  const norm = (s: string) => {
    const r = s.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    return isWin ? r.toLowerCase() : r;
  };
  const compCwd = norm(cwd);
  const match = known.find((ws) => norm(ws) === compCwd);
  if (match) {
    stickyWorkspace = match;
    return match;
  }
  return stickyWorkspace ?? cwd;
}

/** Synchronous best-effort variant for tools that already carry a changeId. */
function workspaceOf(): string {
  return process.env.REVIEW_HUB_WORKSPACE ?? stickyWorkspace ?? process.cwd();
}

/**
 * The SDK's `registerTool` generics instantiate too deeply under this TS/zod combo (TS2589).
 */
interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
}
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface TypedServer {
  registerTool(name: string, config: ToolConfig, cb: ToolCallback): unknown;
  registerResource(
    name: string,
    uriOrTemplate: string,
    config: unknown,
    readCallback: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>,
  ): unknown;
  registerPrompt(
    name: string,
    config: unknown,
    cb: (args: Record<string, unknown>) => Promise<{ messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }> }>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
}

const server = new McpServer({ name: "review-hub", version: "0.3.0" }) as unknown as TypedServer;

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Replaces `oldStr` with `newStr` inside `src`. Tolerates newline differences (CRLF vs LF)
 * so that AI agents editing Windows or cross-platform files do not fail on line endings.
 */

function getLeadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? "";
}

function detectIndentUnit(lines: string[]): string {
  let minDiff = Infinity;
  let isTab = false;
  const indents: number[] = [];
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    const ws = getLeadingWhitespace(l);
    if (ws.includes("\t")) isTab = true;
    indents.push(ws.length);
  }
  indents.sort((a, b) => a - b);
  for (let i = 1; i < indents.length; i++) {
    const diff = indents[i] - indents[i - 1];
    if (diff > 0 && diff < minDiff) {
      minDiff = diff;
    }
  }
  if (isTab) return "\t";
  if (minDiff !== Infinity && minDiff > 0) return " ".repeat(minDiff);
  return "  ";
}

function normLine(line: string): string {
  return line.trim().replace(/[ \t]+/g, " ");
}

function fuzzyReplace(
  src: string,
  oldStr: string,
  newStr: string,
  replaceAll?: boolean,
): { matched: true; next: string } | { matched: false; error?: string } {
  const isCrlf = src.includes("\r\n");
  const eol = isCrlf ? "\r\n" : "\n";
  const srcLines = src.split(/\r?\n/);
  const srcHadTrailingEol = src.endsWith("\n");

  if (srcHadTrailingEol && srcLines.length > 0 && srcLines[srcLines.length - 1] === "") {
    srcLines.pop();
  }

  const rawOldLines = oldStr.split(/\r?\n/);
  const oldHadTrailingEol = oldStr.endsWith("\n");
  const oldLines = (oldHadTrailingEol && rawOldLines.length > 1 && rawOldLines[rawOldLines.length - 1] === "")
    ? rawOldLines.slice(0, -1)
    : rawOldLines;

  const rawNewLines = newStr.split(/\r?\n/);
  const newHadTrailingEol = newStr.endsWith("\n");
  const newLines = (newHadTrailingEol && rawNewLines.length > 1 && rawNewLines[rawNewLines.length - 1] === "")
    ? rawNewLines.slice(0, -1)
    : rawNewLines;

  const oldNorm = oldLines.map(normLine);
  if (oldNorm.length === 0 || (oldNorm.length === 1 && oldNorm[0] === "")) {
    return { matched: false };
  }

  const matches: { start: number; end: number }[] = [];
  for (let i = 0; i <= srcLines.length - oldNorm.length; i++) {
    let ok = true;
    for (let k = 0; k < oldNorm.length; k++) {
      if (normLine(srcLines[i + k]) !== oldNorm[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push({ start: i, end: i + oldNorm.length });
    }
  }

  if (matches.length === 0) {
    return { matched: false };
  }
  if (matches.length > 1 && !replaceAll) {
    return {
      matched: false,
      error: `old_string (fuzzy matched) occurs ${matches.length} times in file; pass replace_all: true or include more surrounding context to make it unique.`,
    };
  }

  const fileIndentUnit = detectIndentUnit(srcLines);
  const oldIndentUnit = detectIndentUnit(oldLines);

  const resultLines = [...srcLines];
  for (let m = matches.length - 1; m >= 0; m--) {
    const { start, end } = matches[m];
    const matchedSrcSlice = resultLines.slice(start, end);

    let oldMinIndentLen = Infinity;
    for (const l of oldLines) {
      if (l.trim().length === 0) continue;
      const ws = getLeadingWhitespace(l);
      if (ws.length < oldMinIndentLen) {
        oldMinIndentLen = ws.length;
      }
    }
    if (oldMinIndentLen === Infinity) {
      oldMinIndentLen = 0;
    }

    let srcBaseIndent = "";
    for (let k = 0; k < oldLines.length; k++) {
      if (oldLines[k].trim().length > 0 && getLeadingWhitespace(oldLines[k]).length === oldMinIndentLen) {
        srcBaseIndent = getLeadingWhitespace(matchedSrcSlice[k]);
        break;
      }
    }

    const sliceIndentUnit = detectIndentUnit(matchedSrcSlice);
    const effectiveSrcIndentUnit = sliceIndentUnit.length > 0 ? sliceIndentUnit : fileIndentUnit;
    const oldUnitLen = oldIndentUnit.length || 2;

    const adaptedNewLines = newLines.map((nl) => {
      if (nl.trim().length === 0) return "";
      const nlWs = getLeadingWhitespace(nl);
      const relSpaces = Math.max(0, nlWs.length - oldMinIndentLen);
      const level = Math.round(relSpaces / oldUnitLen);
      const targetIndent = srcBaseIndent + effectiveSrcIndentUnit.repeat(level);
      return targetIndent + nl.trim();
    });

    resultLines.splice(start, end - start, ...adaptedNewLines);
  }

  let next = resultLines.join(eol);
  if (srcHadTrailingEol) {
    next += eol;
  }
  return { matched: true, next };
}

function adaptReplacement(
  src: string,
  oldStr: string,
  newStr: string,
  replaceAll?: boolean,
): { success: true; next: string } | { success: false; error: string } {
  // 1. Try exact match first
  let count = countOccurrences(src, oldStr);
  let effectiveOld = oldStr;
  let effectiveNew = newStr;

  if (count === 0) {
    // 2. Try newline-normalized match (e.g. file is CRLF but LLM passed LF, or vice versa)
    const isCrlf = src.includes("\r\n");
    const targetOld = isCrlf ? oldStr.replace(/\r?\n/g, "\r\n") : oldStr.replace(/\r\n/g, "\n");
    const targetNew = isCrlf ? newStr.replace(/\r?\n/g, "\r\n") : newStr.replace(/\r\n/g, "\n");
    const normalizedCount = countOccurrences(src, targetOld);
    if (normalizedCount > 0) {
      count = normalizedCount;
      effectiveOld = targetOld;
      effectiveNew = targetNew;
    }
  }

  if (count === 0 && oldStr.trim().length > 0) {
    // 3. Try fuzzy whitespace & indentation tolerance
    const fuzzy = fuzzyReplace(src, oldStr, newStr, replaceAll);
    if (fuzzy.matched) {
      return { success: true, next: fuzzy.next };
    }
    if (fuzzy.error) {
      return { success: false, error: fuzzy.error };
    }
  }

  if (count === 0) {
    return {
      success: false,
      error: `old_string not found in file. Check line numbers or current content with 'read_file'.`,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      success: false,
      error: `old_string occurs ${count} times in file; pass replace_all: true or include more surrounding context to make it unique.`,
    };
  }

  const next = replaceAll ? src.split(effectiveOld).join(effectiveNew) : src.replace(effectiveOld, () => effectiveNew);
  return { success: true, next };
}

function formatHunksToDiff(hunks: Hunk[]): string {
  if (hunks.length === 0) {
    return "No diff hunks.";
  }
  return hunks
    .map((h) => {
      const header = `@@ -${h.oldStart + 1},${h.oldLines.length} +${h.newStart + 1},${h.newLines.length} @@ [${h.id}] (${h.decision})`;
      const oldPart = h.oldLines.map((l) => `-${l}`).join("\n");
      const newPart = h.newLines.map((l) => `+${l}`).join("\n");
      const parts = [header];
      if (oldPart) parts.push(oldPart);
      if (newPart) parts.push(newPart);
      return parts.join("\n");
    })
    .join("\n\n");
}

// ==========================================
// TOOLS
// ==========================================

server.registerTool(
  "propose_edit",
  {
    title: "Propose edit",
    description:
      "Stage an edit to a file for human review instead of writing it. Mirrors the native Edit tool (old_string/new_string). Automatically handles CRLF/LF line ending matching. The user sees a diff and accepts or rejects each hunk; nothing is written until they accept. Prefer this over Edit/Write so the user can review your change.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path to the file."),
      old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence."),
    },
  },
  async (args) => {
    const { path, old_string, new_string, replace_all } = args as {
      path: string; old_string: string; new_string: string; replace_all?: boolean;
    };
    const workspace = await resolveWorkspace(path);
    const current = await callHub<{ exists: boolean; content: string; binary: boolean }>("/file/read", {
      query: { workspace, path },
    });
    if (current.binary) {
      return fail(`cannot propose an edit to a binary file: ${path}`);
    }
    const src = current.exists ? current.content : "";
    const replaced = adaptReplacement(src, old_string, new_string, replace_all);
    if (!replaced.success) {
      return fail(replaced.error);
    }
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, content: replaced.next },
    });
    return ok({
      status: "staged_for_review",
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Edit staged for review. Nothing was written to disk: the user sees it in Review Hub and each hunk is written only when they accept it. Reading the file with your own tools will show the OLD content — that is expected. Use the `read_file` tool to see the staged content. This is success: continue with your task.",
    });
  },
);

server.registerTool(
  "propose_write",
  {
    title: "Propose write",
    description:
      "Stage a full file write (new or replaced) for human review instead of writing it directly. Nothing is written until the user accepts.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      content: z.string().describe("Full new content of the file."),
    },
  },
  async (args) => {
    const { path, content } = args as { path: string; content: string };
    const workspace = await resolveWorkspace(path);
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, content },
    });
    return ok({
      status: "staged_for_review",
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Write staged for review. Nothing was written to disk: the user sees it in Review Hub and each hunk is written only when they accept it. Reading the file with your own tools will show the OLD content — that is expected. Use the `read_file` tool to see the staged content. This is success: continue with your task.",
    });
  },
);

server.registerTool(
  "propose_delete",
  {
    title: "Propose delete",
    description:
      "Stage a file deletion for human review instead of deleting it directly. Nothing is deleted until the user accepts.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path to the file to delete."),
    },
  },
  async (args) => {
    const { path } = args as { path: string };
    const workspace = await resolveWorkspace(path);
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, delete: true },
    });
    return ok({
      status: "staged_for_review",
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Deletion staged for review. Nothing was deleted from disk: the user sees it in Review Hub and the file is deleted only when they accept it.",
    });
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description:
      "Read a workspace file through Review Hub (returns the staged content currently under review). Optionally read a line range or add line numbers.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      start_line: z.number().int().positive().optional().describe("Optional 1-based start line number."),
      end_line: z.number().int().positive().optional().describe("Optional 1-based end line number (inclusive)."),
      line_numbers: z.boolean().optional().describe("Optional boolean to prefix lines with line numbers."),
    },
  },
  async (args) => {
    const { path, start_line, end_line, line_numbers } = args as {
      path: string;
      start_line?: number;
      end_line?: number;
      line_numbers?: boolean;
    };
    const workspace = await resolveWorkspace(path);
    const read = await callHub<{ exists: boolean; content: string; binary: boolean }>("/file/read", {
      query: { workspace, path },
    });
    if (!read.exists) {
      return fail(`file not found: ${path}`);
    }
    if (read.binary) {
      return ok({ path, binary: true, content: read.content });
    }

    const rawLines = read.content.split(/\r?\n/);
    const totalLines = rawLines.length;
    const start = start_line ? Math.max(1, Math.min(start_line, totalLines)) : 1;
    const end = end_line ? Math.max(start, Math.min(end_line, totalLines)) : totalLines;
    const sliced = (start_line !== undefined || end_line !== undefined) ? rawLines.slice(start - 1, end) : rawLines;

    let contentOut = sliced.join("\n");
    if (line_numbers) {
      const maxDigits = String(end).length;
      contentOut = sliced
        .map((line, idx) => `${String(start + idx).padStart(maxDigits, " ")} | ${line}`)
        .join("\n");
    }

    return ok({
      path,
      binary: false,
      total_lines: totalLines,
      start_line: start,
      end_line: end,
      content: contentOut,
    });
  },
);

server.registerTool(
  "list_changes",
  {
    title: "List pending changes",
    description:
      "List every file the agent has changed since the last accepted checkpoint, with hunk counts. Pass `path` when the session's working directory is not the project being edited.",
    inputSchema: {
      path: z.string().optional().describe("A file path inside the project, to disambiguate the workspace."),
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
    },
  },
  async (args) => {
    const { path, workspace: explicit } = args as { path?: string; workspace?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub<{ files: unknown[] }>("/changes/list", { query: { workspace } });
    return ok({ workspace, files: result.files });
  },
);

server.registerTool(
  "get_change",
  {
    title: "Get change details and diff",
    description:
      "Inspect detailed hunks, status, and formatted unified diff for a pending change. Useful to inspect hunk IDs before accepting/rejecting.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path to the file."),
      changeId: z.string().optional().describe("Unique identifier of the change set."),
      include_diff: z.boolean().optional().describe("Whether to include unified diff text (default: true)."),
    },
  },
  async (args) => {
    const { path, changeId, include_diff } = args as { path?: string; changeId?: string; include_diff?: boolean };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const query: Record<string, string> = { workspace };
    if (changeId) query.changeId = changeId;
    if (path) query.path = path;
    const res = await callHub<{ changeSet: ChangeSet }>("/changes/get", { query });
    const cs = res.changeSet;
    const wantDiff = include_diff ?? true;
    return ok({
      changeId: cs.id,
      path: cs.path,
      workspace: cs.workspace,
      origin: cs.origin,
      applied: cs.applied,
      status: cs.status,
      binary: cs.binary,
      hunksCount: cs.hunks.length,
      hunks: cs.hunks,
      diff: wantDiff && !cs.binary ? formatHunksToDiff(cs.hunks) : undefined,
    });
  },
);

server.registerTool(
  "get_change_status",
  {
    title: "Get change status",
    description:
      "Check if your staged change was accepted, rejected, or is still pending review by the human user.",
    inputSchema: {
      changeId: z.string().optional().describe("Unique identifier of the change set returned by propose_edit or propose_write."),
      path: z.string().optional().describe("Workspace-relative path to the file."),
    },
  },
  async (args) => {
    const { path, changeId } = args as { path?: string; changeId?: string };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const query: Record<string, string> = { workspace };
    if (changeId) query.changeId = changeId;
    if (path) query.path = path;
    const res = await callHub<{ changeSet: ChangeSet }>("/changes/get", { query });
    const cs = res.changeSet;
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    const accepted = cs.hunks.filter((h) => h.decision === "accepted").length;
    const rejected = cs.hunks.filter((h) => h.decision === "rejected").length;
    return ok({
      changeId: cs.id,
      path: cs.path,
      overallStatus: cs.status,
      isFullyResolved: cs.status === "resolved",
      hunks: {
        total: cs.hunks.length,
        pending,
        accepted,
        rejected,
      },
    });
  },
);

server.registerTool(
  "accept",
  {
    title: "Accept change",
    description: "Accept all hunks (or specific hunk ids) of a staged change, writing them to disk.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path (alternative to changeId)."),
      changeId: z.string().optional(),
      hunkIds: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    const { path, changeId, hunkIds } = args as {
      path?: string; changeId?: string; hunkIds?: string[];
    };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const result = await callHub("/changes/accept", { method: "POST", body: { workspace, path, changeId, hunkIds } });
    return ok(result);
  },
);

server.registerTool(
  "reject",
  {
    title: "Reject change",
    description: "Reject all hunks (or specific hunk ids) of a change, restoring the baseline for them.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path (alternative to changeId)."),
      changeId: z.string().optional(),
      hunkIds: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    const { path, changeId, hunkIds } = args as {
      path?: string; changeId?: string; hunkIds?: string[];
    };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const result = await callHub("/changes/reject", { method: "POST", body: { workspace, path, changeId, hunkIds } });
    return ok(result);
  },
);

server.registerTool(
  "set_checkpoint",
  {
    title: "Set checkpoint",
    description:
      "Mark the current on-disk state as accepted, so future changes are measured against it. Use after the user has accepted the current state. Pass `workspace` (or a `path` inside it) when the session's working directory is not the project being edited.",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project, as an alternative to `workspace`."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub("/checkpoint/set", { method: "POST", body: { workspace } });
    return ok({ workspace, ok: true, cleared: true, ...(result as object) });
  },
);

server.registerTool(
  "get_checkpoint",
  {
    title: "Get checkpoint info",
    description: "Get information about the current checkpoint for a workspace (timestamp and tracked file count).",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub<{ checkpoint: { workspace: string; setAt: number; files: number } | null }>("/checkpoint/info", {
      query: { workspace },
    });
    return ok({ workspace, checkpoint: result.checkpoint });
  },
);

server.registerTool(
  "clear_checkpoint",
  {
    title: "Clear checkpoint",
    description: "Clear the current checkpoint and reset tracking baseline for a workspace.",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub("/checkpoint/clear", { method: "POST", body: { workspace } });
    return ok({ workspace, ...(result as object) });
  },
);

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description: "List all project workspaces tracked by Review Hub and currently active IDE windows.",
    inputSchema: {},
  },
  async () => {
    const current = workspaceOf();
    const result = await callHub<{ workspaces: string[]; activeFile?: string; focused?: string[] }>("/workspaces");
    return ok({
      currentWorkspace: current,
      workspaces: result.workspaces,
      activeFile: result.activeFile,
      focusedWorkspaces: result.focused,
    });
  },
);

// ==========================================
// RESOURCES
// ==========================================

server.registerResource(
  "changes",
  "review-hub://changes",
  {
    title: "Pending Changes",
    description: "Real-time list of all files with pending hunks awaiting review in Review Hub.",
    mimeType: "application/json",
  },
  async () => {
    const ws = await resolveWorkspace();
    const result = await callHub<{ files: unknown[] }>("/changes/list", { query: { workspace: ws } });
    return {
      contents: [
        {
          uri: "review-hub://changes",
          mimeType: "application/json",
          text: JSON.stringify({ workspace: ws, files: result.files }, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "workspaces",
  "review-hub://workspaces",
  {
    title: "Tracked Workspaces",
    description: "List of workspaces currently active in Review Hub.",
    mimeType: "application/json",
  },
  async () => {
    const wsList = await hubWorkspaces();
    return {
      contents: [
        {
          uri: "review-hub://workspaces",
          mimeType: "application/json",
          text: JSON.stringify({ current: workspaceOf(), workspaces: wsList }, null, 2),
        },
      ],
    };
  },
);

// ==========================================
// PROMPTS
// ==========================================

server.registerPrompt(
  "review_pending_changes",
  {
    title: "Review pending changes",
    description: "Analyze all pending code changes in Review Hub, provide feedback, and recommend accept/reject actions.",
    inputSchema: {
      workspace: z.string().optional().describe("Workspace path (optional)."),
    },
  },
  async (args) => {
    const ws = (args?.workspace as string) ?? (await resolveWorkspace());
    const result = await callHub<{
      files: Array<{ path: string; added: number; removed: number; pending: number }>;
    }>("/changes/list", { query: { workspace: ws } });
    const summary = result.files.length > 0
      ? result.files.map((f) => `- ${f.path} (+${f.added} -${f.removed}, ${f.pending} pending hunks)`).join("\n")
      : "No pending changes.";

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please review all pending changes in Review Hub for workspace '${ws}':\n\n${summary}\n\nUse the get_change tool to inspect the detailed diff for each file, evaluate the quality, and recommend which hunks should be accepted or rejected.`,
          },
        },
      ],
    };
  },
);

// ==========================================
// MAIN
// ==========================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`review-hub mcp server failed: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
