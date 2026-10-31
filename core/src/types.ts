/**
 * Shared DTOs between the hub HTTP server, the extension UI, and the stdio MCP server.
 * Keep this file free of any `vscode` or Node-only imports so it can be bundled into both.
 */

export type HunkDecision = "pending" | "accepted" | "rejected";

export type ChangeOrigin = "mcp" | "fs";

export type ChangeStatus = "pending" | "applied" | "resolved";

export interface Hunk {
  /** Stable id derived from the hunk's anchor and content, so decisions survive a rebase. */
  id: string;
  /** 0-based line index in the baseline where this hunk starts. */
  oldStart: number;
  /** Baseline lines for this hunk (empty for a pure insertion). */
  oldLines: string[];
  /** 0-based line index in the proposed content where this hunk starts. */
  newStart: number;
  /** Proposed lines for this hunk (empty for a pure deletion). */
  newLines: string[];
  decision: HunkDecision;
}

export interface ChangeSet {
  id: string;
  /** Absolute workspace folder this file belongs to (multi-root support). */
  workspace: string;
  /** Workspace-relative POSIX path. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  origin: ChangeOrigin;
  /** True when `proposed` is already on disk (a direct write we observed). */
  applied: boolean;
  /** Line ending used by the file: "\n" or "\r\n". */
  eol: "\n" | "\r\n";
  /** Whether the file starts with a UTF-8 BOM. */
  bom: boolean;
  /** Whether the file had a trailing newline at the baseline. */
  finalNewline: boolean;
  /** True for files we cannot line-diff (binary / too large). */
  binary: boolean;
  /** Content at the last accepted checkpoint (O). Empty string for a new file. */
  baseline: string;
  /**
   * True when `baseline` holds base64-encoded raw bytes rather than utf8 text.
   * Optional: an absent value means "same as `binary`" (legacy / hand-built sets).
   */
  baselineB64?: boolean;
  /** The newest content the agent wants (C). Empty string for a deleted file. */
  proposed: string;
  /** null when the file did not exist at the checkpoint. */
  baselineExists: boolean;
  /** false when the agent deleted the file. */
  proposedExists: boolean;
  hunks: Hunk[];
  status: ChangeStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ChangeSummary {
  id: string;
  workspace: string;
  path: string;
  origin: ChangeOrigin;
  applied: boolean;
  status: ChangeStatus;
  binary: boolean;
  added: number;
  removed: number;
  accepted: number;
  rejected: number;
  pending: number;
}

export interface ProposeRequest {
  workspace: string;
  path: string;
  /** New full content of the file. */
  content?: string;
  /** When true the agent intends to delete the file. */
  delete?: boolean;
}

export interface ProposeResult {
  changeId: string;
  path: string;
  hunks: Hunk[];
  applied: boolean;
  note: string;
}

export interface ObserveRequest {
  workspace: string;
  path: string;
  reason?: string;
}

export interface DecideRequest {
  changeId?: string;
  path?: string;
  workspace?: string;
  /** Omit to decide every hunk in the change set. */
  hunkIds?: string[];
}

export interface DecideResult {
  changeId: string;
  status: ChangeStatus;
  resolved: boolean;
  remaining: number;
  hunks: Hunk[];
}

export interface CheckpointInfo {
  workspace: string;
  setAt: number;
  files: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

export const HUB_PROTOCOL = 1;

/**
 * A changed file, as passed across the webview boundary and between commands.
 *
 * A plain serialisable shape, not a class: webview commands cannot pass class instances
 * over the message boundary, and the tree's `FileNode` carried a whole `ChangeSummary`.
 */
export interface FileNode {
  workspace: string;
  path: string;
}
