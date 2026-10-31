# Review Hub for JetBrains IDEs

The official Review Hub plugin for IntelliJ IDEA, WebStorm, PyCharm, CLion, GoLand, Android Studio, PhpStorm, Rider, RustRover, and all other JetBrains IDEs.

## Features
- **Review Hub ToolWindow**: Dockable panel showing all pending changes grouped by file and hunk count.
- **Side-by-Side Diff Viewer**: Native IntelliJ 2-way and 3-way diff view to inspect old vs proposed content.
- **In-Editor Inlay Annotations**: Real-time gutter badges and inlay hints on exact lines modified by AI agents.
- **Project Tree File Status**: Custom status badges and file coloring for pending agent changes.
- **One-Click MCP Config**: Copy the standard `review-hub-mcp` configuration directly to the clipboard.

## Architecture
The JetBrains plugin communicates via HTTP REST with the local Review Hub Server (`core`). If no Hub Server is currently running, the plugin automatically spawns the bundled `hub-server.cjs` background process.

## Building from Source

Requirements:
- JDK 17 or higher
- Gradle (provided via `./gradlew`)

```bash
# Build the plugin package (.zip)
./gradlew buildPlugin

# The built artifact will be in:
# build/distributions/review-hub-jetbrains-<version>.zip
```

To run a test instance of IntelliJ with the plugin installed:
```bash
./gradlew runIde
```

