import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { readGitBaseline, isGitRepo } from "../core/src/git-baseline";

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return dir;
}

test("reads HEAD content of a tracked file", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "committed line\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // Change it on disk without committing.
  fs.writeFileSync(path.join(dir, "a.txt"), "changed line\n");

  const base = await readGitBaseline(dir, "a.txt");
  assert.equal(base.isRepo, true);
  assert.equal(base.content, "committed line\n");
});

test("returns null for a file not tracked at HEAD", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
  const base = await readGitBaseline(dir, "untracked.txt");
  assert.equal(base.isRepo, true);
  assert.equal(base.content, null);
});

test("reports not-a-repo for a plain directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-nogit-"));
  const base = await readGitBaseline(dir, "a.txt");
  assert.equal(base.isRepo, false);
  assert.equal(await isGitRepo(dir), false);
});

test("refuses path traversal", async () => {
  const dir = gitRepo();
  const base = await readGitBaseline(dir, "../escape.txt");
  assert.equal(base.isRepo, false);
  assert.equal(base.content, null);
});
