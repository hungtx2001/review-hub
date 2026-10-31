/**
 * Filesystem helpers for reading/writing file content safely: binary detection,
 * atomic writes, path containment. No `vscode` import so the hub and tests can use it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface FileReadResult {
  exists: boolean;
  content: string;
  binary: boolean;
  hash: string;
}

const NUL = 0;

export function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(NUL);
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readFileSafe(absPath: string): FileReadResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return { exists: false, content: "", binary: false, hash: hashContent("") };
  }
  if (isBinaryBuffer(buf)) {
    return { exists: true, content: "", binary: true, hash: hashContent(buf) };
  }
  const content = buf.toString("utf8");
  return { exists: true, content, binary: false, hash: hashContent(buf) };
}

/** Write text atomically: write a sibling tmp file, then rename over the target. */
export function writeFileAtomic(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, absPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EEXIST") {
      try {
        fs.unlinkSync(absPath);
        fs.renameSync(tmp, absPath);
        return;
      } catch {
        fs.copyFileSync(tmp, absPath);
        try { fs.unlinkSync(tmp); } catch {}
        return;
      }
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Raw bytes of a file, or `undefined` when it cannot be read. */
export function readFileBytes(absPath: string): Buffer | undefined {
  try {
    return fs.readFileSync(absPath);
  } catch {
    return undefined;
  }
}

/**
 * Write bytes atomically, like `writeFileAtomic` but without the utf8 round-trip.
 * Needed for binaries: decoding bytes to a string and re-encoding them mangles every
 * non-utf8 sequence (a 10-byte file can become 16 bytes of U+FFFD).
 */
export function writeFileAtomicBytes(absPath: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, absPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EEXIST") {
      try {
        fs.unlinkSync(absPath);
        fs.renameSync(tmp, absPath);
        return;
      } catch {
        fs.copyFileSync(tmp, absPath);
        try { fs.unlinkSync(tmp); } catch {}
        return;
      }
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

const B64_PREFIX = "b64:";
const BIN_PREFIX = "bin:";

/**
 * Encode raw bytes for a string-valued baseline slot. `bin:`-prefixed values are
 * always base64 of the raw bytes, so a reader never has to guess an encoding.
 */
export function encodeBaseline(bytes: Buffer): string {
  return BIN_PREFIX + bytes.toString("base64");
}

/** Decode a baseline value that was encoded with `encodeBaseline`. */
export function decodeBaseline(s: string): Buffer {
  return Buffer.from(s.slice(BIN_PREFIX.length), "base64");
}

/**
 * `b64:`-prefixed values are legacy: they were written by an earlier revision of this
 * branch, before the encoding became explicit. Nothing writes them any more, but a
 * stored value must still decode rather than silently corrupt a file.
 */
export function isEncodedBaseline(s: string): boolean {
  return s.startsWith(BIN_PREFIX) || s.startsWith(B64_PREFIX);
}

export function deleteFileSafe(absPath: string): void {
  try {
    fs.unlinkSync(absPath);
  } catch {
    // already gone
  }
}

/**
 * Resolve a path and refuse anything that escapes the workspace.
 * Returns null when the path is outside the workspace (path traversal guard).
 *
 * Accepts either form: an absolute path that already sits inside the workspace is used
 * as-is, anything else is treated as workspace-relative. Both are then re-checked by
 * containment, so a path like `/etc/passwd` (or `../secrets`) is still rejected.
 */
export function resolveInside(workspace: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/");
  const isWin = process.platform === "win32";
  // On Windows, a leading slash without a drive letter (/foo/bar) is not a full absolute
  // path; it is intended as workspace-relative. Treat only drive paths (C:/...) as absolute.
  const isAbsolute = isWin ? /^[A-Za-z]:[\\/]/.test(normalized) : path.isAbsolute(normalized);
  const abs = isAbsolute
    ? path.resolve(normalized)
    : path.resolve(workspace, normalized.replace(/^\/+/, ""));
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
