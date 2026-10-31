import { build } from "esbuild";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const outDir = ".test-dist";
const homeDir = path.join(outDir, "home");
// The tests create throwaway workspaces with os.tmpdir(). Point TMPDIR at a sandbox so a
// run does not litter the real temp dir, and remove it when the run finishes.
//
// This sandbox MUST sit outside the repository. Tests assert that `gitChangedFiles`
// returns null for a plain (non-repo) directory; if the temp dir lived inside our own git
// worktree, git would walk up from it and find this repository, and the assertion would
// fail. It must also be absolute, so paths the tests derive from os.tmpdir() are absolute.
const tmpDir = path.join(os.tmpdir(), "review-hub-test-tmp");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("test", f));

if (files.length === 0) {
  console.error("no tests found in test/");
  process.exit(1);
}

const outputs = files.map((f) => path.join(outDir, path.basename(f).replace(/\.ts$/, ".js")));

await build({
  entryPoints: files,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "inline",
  external: ["esbuild", "node:sqlite"],
  alias: { vscode: path.resolve("test", "vscode-stub.ts") },
  logLevel: "silent",
});

const result = spawnSync(process.execPath, ["--test", ...outputs], {
  stdio: "inherit",
  env: { ...process.env, HOME: homeDir, TMPDIR: tmpDir },
});
rmSync(tmpDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
