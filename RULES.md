# AI Agent Rules for Review Hub

To ensure AI coding agents (Claude Code, Cursor, Cline, Roo Code, Antigravity, Windsurf, etc.) use Review Hub to propose edits instead of modifying project files directly, add the enforcement rules below to your project.

---

## ⚡ 1-Click Copy or Install

- **In VS Code:** 
  - Click **Copy AI Agent Rules** (`Review Hub: Copy AI Agent Rules to Clipboard`) from the Command Palette or the Changes view toolbar to copy the snippet to your clipboard.
  - Or run **`Review Hub: Install agent instructions`** to automatically create/update rule files for all detected AI harnesses in your workspace.
- **In JetBrains IDEs:**
  - Click the **Copy AI Agent Rules** icon in the Review Hub tool window toolbar or under `Tools -> Review Hub -> Copy AI Agent Rules`.

---

## 📋 Standard Rule Snippet

Copy and paste the following block into the rule file corresponding to your AI tool:

```markdown
<!-- review-hub:start -->
## Review Hub (required)

This project uses Review Hub to review AI edits. **Do not use the built-in `edit`, `write`, or shell commands to modify source files.** Use the Review Hub MCP tools instead, so every change is recorded and the user can accept or reject each hunk:

- `propose_edit` (or `mcp__review_hub__propose_edit`) — change a file. Same arguments as the native edit tool: `path`, `old_string`, `new_string`, optional `replace_all`.
  **Use this instead of `edit`.**
- `propose_write` (or `mcp__review_hub__propose_write`) — create or replace a whole file (`path`, `content`).
  **Use this instead of `write`.**
- `propose_delete` (or `mcp__review_hub__propose_delete`) — delete a file (`path`).
  **Use this instead of `rm`.**
- `read_file` (or `mcp__review_hub__read_file`) — read a file (`path`).
- `list_changes` (or `mcp__review_hub__list_changes`) — list files changed since the last accepted checkpoint.
- Review Hub **does not write your edit to disk until the user accepts it**. Reading the file with your own tools will show the OLD content — that is expected, not a failed edit.
- Use the `read_file` tool (not `cat`/Read) to see the content you have staged so far.

A `propose_*` call returns `status: "staged_for_review"` with a `changeId`. That is **success, not an error**. The edit is staged and the user reviews it; do not retry with a different tool and do not ask for confirmation.

Only fall back to the built-in tools if a Review Hub tool returns an error saying the hub is unreachable.
<!-- review-hub:end -->
```

---

## 📁 Where to Put the Rules

Place the snippet into the appropriate file at the root of your project:

| AI Agent / IDE | File Name | Notes |
| :--- | :--- | :--- |
| **Claude Code** | `CLAUDE.md` | Auto-loaded on every session |
| **Cursor** | `.cursorrules` or `.cursor/rules/*.mdc` | Always applied to code editing |
| **Cline** | `.clinerules` | Read by Cline system prompt |
| **Roo Code** | `.clinerules` or `.roomodes` | Custom instructions for Code mode |
| **Antigravity / Gemini** | `AGENTS.md` or `GEMINI.md` | Standard project instruction file |
| **Windsurf** | `.windsurfrules` | Project context rules |
| **GitHub Copilot** | `.github/copilot-instructions.md` | Copilot workspace instructions |

---

## 🛡️ Extra Tip: Enforce via Agent Settings (Optional)

In agent harnesses that support disabling specific tools (such as **Cline** or **Roo Code**):
1. Open the tool settings or mode configuration.
2. Disable/uncheck native write tools (`write_to_file`, `replace_in_file`).
3. Keep `use_mcp_tool` enabled.

This forces the AI agent to use Review Hub's MCP tools 100% of the time.

