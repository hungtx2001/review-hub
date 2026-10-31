import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gitChangedFiles } from "../core/src/git-baseline";

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-gc-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return dir;
}

test("gitChangedFiles returns null outside a repo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-nogit-"));
  assert.equal(await gitChangedFiles(dir), null);
});

test("gitChangedFiles lists a modified tracked file", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one changed\n");
  const changed = await gitChangedFiles(dir);
  assert.ok(changed);
  assert.deepEqual(changed, ["a.txt"]);
});

test("gitChangedFiles lists an untracked file", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
  const changed = await gitChangedFiles(dir);
  assert.ok(changed);
  assert.ok(changed.includes("new.txt"));
});

test("gitChangedFiles returns empty when the tree is clean", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  assert.deepEqual(await gitChangedFiles(dir), []);
});

test("gitChangedFiles reports a deleted file", async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  fs.unlinkSync(path.join(dir, "a.txt"));
  const changed = await gitChangedFiles(dir);
  assert.ok(changed);
  assert.ok(changed.includes("a.txt"));
});
