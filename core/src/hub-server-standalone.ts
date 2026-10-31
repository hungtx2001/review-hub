/**
 * Standalone runner for Review Hub HTTP server.
 * Can be spawned by JetBrains Plugin, CLI, or other IDEs when VS Code is not open.
 */
import { HubServer } from "./hub-server";
import { createRegistry, defaultBaseDir, pidAlive, type HubEntry } from "./registry";
import { HUB_PROTOCOL } from "./types";

async function main() {
  const baseDir = process.env.REVIEW_HUB_DIR ?? defaultBaseDir();
  const registry = createRegistry(baseDir);

  const existing = registry.readEntry();
  if (existing && pidAlive(existing.pid)) {
    console.log(JSON.stringify({ status: "already_running", url: existing.url, pid: existing.pid }));
    return;
  }

  const workspace = process.argv[2] ?? process.cwd();
  const hub = new HubServer({
    baseDir,
    liveWorkspaces: () => [workspace],
  });

  await registry.withLock(async () => {
    const check = registry.readEntry();
    if (check && pidAlive(check.pid)) {
      console.log(JSON.stringify({ status: "already_running", url: check.url, pid: check.pid }));
      return;
    }
    const addr = await hub.start(0);
    const entry: HubEntry = {
      url: addr.url,
      token: addr.token,
      pid: process.pid,
      workspace,
      updatedAt: Date.now(),
      protocol: HUB_PROTOCOL,
    };
    registry.writeEntry(entry);
    console.log(JSON.stringify({ status: "started", url: addr.url, port: addr.port, token: addr.token, pid: process.pid }));

    const cleanup = async () => {
      try {
        const cur = registry.readEntry();
        if (cur && cur.pid === process.pid) {
          registry.clearEntry();
        }
      } catch {}
      await hub.stop();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", () => {
      try {
        const cur = registry.readEntry();
        if (cur && cur.pid === process.pid) {
          registry.clearEntry();
        }
      } catch {}
    });
  });
}

main().catch((err) => {
  console.error("Failed to start standalone hub:", err);
  process.exit(1);
});
