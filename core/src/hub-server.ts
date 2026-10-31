/**
 * The Review Hub HTTP server. Runs inside the VS Code extension process and is the
 * single landing place for both the extension UI and the stdio MCP servers that
 * harnesses spawn. Binds 127.0.0.1 only and requires a bearer token.
 *
 * No `vscode` import: unit-testable with a plain node:http client.
 */
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { ChangeStore, type SnapshotOptions } from "./change-store";
import { readFileSafe, resolveInside, toPosix } from "./file-snapshot";
import { resolveLines, splitContent, joinContent } from "./hunk-diff";
import type { WindowState } from "./window-registry";
import type { ApiError, ChangeSet } from "./types";
import { HUB_PROTOCOL } from "./types";

export interface HubEvents {
  onChanged?: (workspace: string, path: string, changeId: string) => void;
  onResolved?: (workspace: string, path: string, changeId: string) => void;
}

export interface HubOptions extends HubEvents {
  baseDir?: string;
  maxFileSize?: number;
  excludeGlobs?: string[];
  snapshot?: Partial<SnapshotOptions>;
  /** For tests: fixed token. Otherwise a random one is generated. */
  token?: string;
  /** Folders currently open in the window(s) serving this hub, for tool-call routing. */
  liveWorkspaces?: () => string[];
  /** Every live window's published state, for routing across windows. */
  windowStates?: () => WindowState[];
}

export interface HubAddress {
  url: string;
  token: string;
  port: number;
}

export class HubServer {
  readonly store: ChangeStore;
  private server: http.Server | undefined;
  private token: string;
  private address: HubAddress | undefined;
  private events: HubEvents;
  private snapshotOpts: SnapshotOptions;
  private liveWorkspaces: (() => string[]) | undefined;
  private windowStates: (() => WindowState[]) | undefined;

  constructor(opts: HubOptions = {}) {
    this.store = new ChangeStore({ baseDir: opts.baseDir, maxFileSize: opts.maxFileSize, excludeGlobs: opts.excludeGlobs });
    this.token = opts.token ?? randomBytes(32).toString("hex");
    this.events = { onChanged: opts.onChanged, onResolved: opts.onResolved };
    this.liveWorkspaces = opts.liveWorkspaces;
    this.windowStates = opts.windowStates;
    this.snapshotOpts = {
      maxFileSize: opts.snapshot?.maxFileSize ?? opts.maxFileSize ?? 2 * 1024 * 1024,
      excludeGlobs: opts.snapshot?.excludeGlobs ?? opts.excludeGlobs ?? [],
      includeExtensions: opts.snapshot?.includeExtensions,
      maxFiles: opts.snapshot?.maxFiles,
      maxDurationMs: opts.snapshot?.maxDurationMs,
    };
  }

  async start(preferredPort = 0): Promise<HubAddress> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.send(res, 500, { error: { code: "internal", message: String(err?.message ?? err) } });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(preferredPort, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.address = { url: `http://127.0.0.1:${port}`, token: this.token, port };
    return this.address;
  }

  getAddress(): HubAddress | undefined {
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Release the SQLite handle so a restart in the same process does not leak it.
    this.store.dispose();
  }

  // ---- routing ----

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      this.send(res, 401, { error: { code: "unauthorized", message: "missing or bad bearer token" } });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /healthz":
          return this.send(res, 200, { ok: true, protocol: HUB_PROTOCOL });
        case "POST /changes/propose":
          return this.send(res, 200, await this.routePropose(await this.body(req)));
        case "POST /changes/observe":
          return this.send(res, 200, await this.routeObserve(await this.body(req)));
        case "GET /changes/list":
          return this.send(res, 200, { files: this.store.listChanges(this.canonicalWorkspace(this.param(url, "workspace")) ?? this.param(url, "workspace")) });
        case "GET /changes/get":
          return this.send(res, 200, this.routeGet(url));
        case "POST /changes/accept":
          return this.send(res, 200, this.routeDecide(await this.body(req), "accept"));
        case "POST /changes/reject":
          return this.send(res, 200, this.routeDecide(await this.body(req), "reject"));
        case "POST /changes/undo":
          return this.send(res, 200, this.routeDecide(await this.body(req), "reject"));
        case "POST /checkpoint/set":
          return this.send(res, 200, await this.routeCheckpointSet(await this.body(req)));
        case "POST /checkpoint/clear":
          return this.send(res, 200, this.routeCheckpointClear(await this.body(req)));
        case "GET /checkpoint/info":
          return this.send(res, 200, { checkpoint: this.store.checkpointInfo(this.canonicalWorkspace(this.param(url, "workspace")) ?? this.param(url, "workspace")) ?? null });
        case "GET /content":
          return this.routeContent(url, res);
        case "GET /file/read":
          return this.routeFileRead(url, res);
        case "GET /workspaces":
          return this.send(res, 200, this.routeWorkspaces());
        default:
          return this.send(res, 404, { error: { code: "not_found", message: route } });
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      this.send(res, e.status ?? 400, { error: { code: "bad_request", message: e.message ?? String(err) } });
    }
  }

  private canonicalWorkspace(requested?: string): string | undefined {
    if (!requested) return undefined;
    const isWin = process.platform === "win32";
    const norm = (s: string) => {
      const r = s.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      return isWin ? r.toLowerCase() : r;
    };
    const compReq = norm(requested);
    const known = this.store.listKnownWorkspaces();
    const hit = known.find((ws) => norm(ws) === compReq);
    return hit ?? requested;
  }

  private routePropose(body: Record<string, unknown>) {
    const workspace = this.canonicalWorkspace(this.requireString(body, "workspace"))!;
    const relPath = this.requireString(body, "path");
    const del = body.delete === true;
    const content = del ? "" : this.requireString(body, "content", true);
    const cs = this.store.propose(workspace, relPath, content, { delete: del });
    this.events.onChanged?.(workspace, cs.path, cs.id);
    return { changeId: cs.id, path: cs.path, hunks: cs.hunks, applied: false, note: "staged, awaiting review" };
  }

  private async routeObserve(body: Record<string, unknown>) {
    const workspace = this.canonicalWorkspace(this.requireString(body, "workspace"))!;
    const relPath = this.requireString(body, "path");
    const cs = await this.store.observe(workspace, relPath);
    if (!cs) {
      return { change: null };
    }
    this.events.onChanged?.(workspace, cs.path, cs.id);
    return { changeId: cs.id, path: cs.path, hunks: cs.hunks, applied: true };
  }

  private routeGet(url: URL) {
    let changeId = this.param(url, "changeId");
    const workspace = this.canonicalWorkspace(this.param(url, "workspace"));
    const relPath = this.param(url, "path");
    if (!changeId && workspace && relPath) {
      const abs = resolveInside(workspace, relPath);
      const relKey = abs ? toPosix(path.relative(workspace, abs)) : toPosix(relPath);
      changeId = this.store.findChangeByPath(workspace, relKey)?.id ?? "";
    }
    const cs = workspace ? this.store.getChange(workspace, changeId) : this.storeById(changeId);
    if (!cs) {
      const err: ApiError = { error: { code: "not_found", message: `unknown change ${changeId || relPath}` } };
      throw Object.assign(new Error(err.error.message), { status: 404 });
    }
    return { changeSet: cs };
  }

  private storeById(changeId: string): ChangeSet | undefined {
    // Change ids are unique; scan all workspaces.
    const anyStore = this.store as unknown as { findById?: (id: string) => ChangeSet | undefined };
    return anyStore.findById?.(changeId);
  }

  private routeDecide(body: Record<string, unknown>, kind: "accept" | "reject") {
    let changeId = typeof body.changeId === "string" ? body.changeId : undefined;
    const workspace = this.canonicalWorkspace(typeof body.workspace === "string" ? body.workspace : undefined);
    const path = typeof body.path === "string" ? body.path : undefined;
    if (!changeId && workspace && path) {
      changeId = this.store.findChangeByPath(workspace, path)?.id;
    }
    if (!changeId) {
      throw new Error("changeId (or workspace+path) is required");
    }
    const hunkIds = Array.isArray(body.hunkIds) ? (body.hunkIds as string[]) : undefined;
    const result = kind === "accept" ? this.store.accept(changeId, hunkIds) : this.store.reject(changeId, hunkIds);
    if (result.resolved) {
      this.events.onResolved?.(workspace ?? "", path ?? "", changeId);
    } else {
      this.events.onChanged?.(workspace ?? "", path ?? "", changeId);
    }
    return result;
  }

  private async routeCheckpointSet(body: Record<string, unknown>) {
    const workspace = this.canonicalWorkspace(this.requireString(body, "workspace"))!;
    const info = await this.store.setCheckpoint(workspace, this.snapshotOpts);
    this.events.onChanged?.(workspace, "", "");
    return info;
  }

  private routeCheckpointClear(body: Record<string, unknown>) {
    const workspace = this.canonicalWorkspace(this.requireString(body, "workspace"))!;
    this.store.clearCheckpoint(workspace);
    this.events.onChanged?.(workspace, "", "");
    return { ok: true };
  }

  private routeContent(url: URL, res: http.ServerResponse): void {
    const changeId = this.param(url, "changeId");
    const side = this.param(url, "side") || "proposed";
    const cs = this.storeById(changeId);
    if (!cs) {
      this.send(res, 404, { error: { code: "not_found", message: changeId } });
      return;
    }
    const content = side === "baseline" ? cs.baseline : cs.proposed;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(content);
  }

  /**
   * Read a file **through the review state**, not from the disk.
   *
   * Under review-then-apply the disk holds only the baseline plus whatever the user has
   * already accepted, so an agent's own pending edits are not there. An agent that makes
   * two sequential `propose_edit` calls sends the second one's `old_string` from the first
   * one's output, so this route must report the *staged* content — baseline with every
   * non-rejected hunk materialised — or the second call fails. Falls back to the disk when
   * no change exists for the path.
   */
  private routeFileRead(url: URL, res: http.ServerResponse): void {
    const workspace = this.canonicalWorkspace(this.param(url, "workspace")) ?? this.param(url, "workspace");
    const relPath = this.param(url, "path");
    const abs = resolveInside(workspace, relPath);
    if (!abs) {
      this.send(res, 400, { error: { code: "bad_path", message: relPath } });
      return;
    }
    // A ChangeSet's `path` is workspace-relative (see ChangeStore.propose), so derive the
    // lookup key from the resolved absolute path: a caller may pass either a relative or an
    // absolute in-workspace path, and only the relative form would otherwise match.
    const relKey = toPosix(path.relative(workspace, abs));
    const cs = this.store.findChangeByPath(workspace, relKey);
    if (cs && !cs.binary) {
      if (!cs.proposedExists) {
        this.send(res, 200, {
          exists: false,
          binary: false,
          content: "",
          hash: "",
          path: toPosix(relPath),
          staged: true,
        });
        return;
      }
      const base = splitContent(cs.baseline);
      const lines = resolveLines(base.lines, cs.hunks, "proposed");
      const content = joinContent(lines, { eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline });
      this.send(res, 200, {
        exists: true,
        binary: false,
        content,
        hash: "",
        path: toPosix(relPath),
        staged: true,
      });
      return;
    }
    const read = readFileSafe(abs);
    this.send(res, 200, {
      exists: read.exists,
      binary: read.binary,
      content: read.content,
      hash: read.hash,
      path: toPosix(relPath),
    });
  }

  /**
   * The workspaces this hub can serve, most relevant first.
   *
   * The MCP server needs this to route a tool call: a harness spawns it once with a fixed
   * working directory, but the agent may work in any project the user has open, so a
   * relative `path` has to be resolved against the right workspace rather than guessed
   * from `process.cwd()`.
   *
   * Order matters — the MCP server probes candidates in order for a relative path:
   *   1. folders of every live window, most recently focused first, with the focused
   *      window's active file's project leading (that is where the user is working);
   *   2. folders of the window hosting this hub;
   *   3. every workspace with stored state, as a last resort.
   */
  private routeWorkspaces(): { workspaces: string[]; activeFile?: string; focused?: string[] } {
    const states = this.windowStates?.() ?? [];
    const focused = states.flatMap((s) => s.folders);
    const activeFile = states.find((s) => s.activeFile)?.activeFile;
    const live = this.liveWorkspaces?.() ?? [];
    const known = this.store.listKnownWorkspaces();

    const seen = new Set<string>();
    const out: string[] = [];
    // The project of the user's active file goes first: a relative path almost certainly
    // belongs to what they are looking at.
    if (activeFile) {
      const owner = [...focused, ...live]
        .filter((ws) => activeFile === ws || activeFile.startsWith(ws.replace(/[\\/]+$/, "") + "/"))
        .sort((a, b) => b.length - a.length)[0];
      if (owner) {
        seen.add(owner);
        out.push(owner);
      }
    }
    for (const ws of [...focused, ...live, ...known]) {
      if (ws && !seen.has(ws)) {
        seen.add(ws);
        out.push(ws);
      }
    }
    return { workspaces: out, activeFile, focused };
  }

  // ---- helpers ----

  private authorized(req: http.IncomingMessage): boolean {
    // Reject browser-originated requests (CSRF guard). Node fetch sends no Origin.
    if (req.headers.origin) {
      return false;
    }
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${this.token}`;
    if (auth.length !== expected.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < auth.length; i++) {
      diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  private body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 32 * 1024 * 1024) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === "object" ? parsed : {});
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private param(url: URL, name: string): string {
    return url.searchParams.get(name) ?? "";
  }

  private requireString(body: Record<string, unknown>, key: string, allowEmpty = false): string {
    const value = body[key];
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
      throw new Error(`${key} must be a non-empty string`);
    }
    return value;
  }

  private send(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  }
}
