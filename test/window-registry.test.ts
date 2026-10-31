import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeWindowState, readWindowStates, clearWindowState } from "../core/src/window-registry";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-win-"));
}

test("window state round-trips and is readable", () => {
  const base = tmp();
  writeWindowState(base, {
    pid: process.pid,
    folders: ["/proj/a"],
    activeFile: "/proj/a/README.md",
    focusedAt: 1000,
    updatedAt: 1000,
  });
  const states = readWindowStates(base);
  assert.equal(states.length, 1);
  assert.deepEqual(states[0].folders, ["/proj/a"]);
  assert.equal(states[0].activeFile, "/proj/a/README.md");
});

test("stale windows (dead pid) are dropped and their files removed", () => {
  const base = tmp();
  // A pid that cannot be alive: 2^31-1 is above the Linux pid ceiling.
  writeWindowState(base, {
    pid: 2147483646,
    folders: ["/proj/dead"],
    focusedAt: 9999,
    updatedAt: 9999,
  });
  writeWindowState(base, {
    pid: process.pid,
    folders: ["/proj/live"],
    focusedAt: 1,
    updatedAt: 1,
  });
  const states = readWindowStates(base);
  assert.equal(states.length, 1, "only the live window remains");
  assert.deepEqual(states[0].folders, ["/proj/live"]);
  const files = fs.readdirSync(path.join(base, "windows"));
  assert.deepEqual(files, [`${process.pid}.json`], "the stale file was removed");
});

test("most recently focused window comes first", () => {
  const base = tmp();
  // Both use the current pid so neither is treated as stale; use distinct filenames by
  // writing then renaming, since the file name is derived from the pid.
  writeWindowState(base, { pid: process.pid, folders: ["/old"], focusedAt: 1, updatedAt: 1 });
  const first = path.join(base, "windows", `${process.pid}.json`);
  fs.renameSync(first, path.join(base, "windows", "other.json"));
  writeWindowState(base, { pid: process.pid, folders: ["/new"], focusedAt: 5000, updatedAt: 5000 });

  const states = readWindowStates(base);
  assert.equal(states[0].folders[0], "/new", "the later-focused window leads");
});

test("clearWindowState removes this window's file", () => {
  const base = tmp();
  writeWindowState(base, { pid: process.pid, folders: ["/x"], focusedAt: 1, updatedAt: 1 });
  assert.equal(readWindowStates(base).length, 1);
  clearWindowState(base, process.pid);
  assert.equal(readWindowStates(base).length, 0);
});

test("a missing directory reads as no windows", () => {
  assert.deepEqual(readWindowStates(path.join(tmp(), "nope")), []);
});
