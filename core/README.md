# @review-hub/core

The standalone core engine of Review Hub:
- **SQLite Change Store**: ACID transactional storage for file baselines and multi-hunk pending/decided changes.
- **Hunk Diffing Engine**: Accurate computation of diff hunks, 3-way merge resolutions, and line tracking.
- **Git Baselines & Snapshots**: Tracking working tree checkpoints and snapshots.
- **REST Hub Server**: Local HTTP REST service communicating with IDE extensions (VS Code, JetBrains) and the MCP server.

This package has zero dependencies on any IDE or editor SDK. It runs independently under Node.js 22+.

## Building
```bash
npm run build
```
Produces `dist/hub-server.cjs` and `core/dist/hub-server.cjs`.
