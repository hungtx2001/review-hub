<!-- review-hub:start -->
## Review Hub (required)

This project uses Review Hub (JetBrains Plugin Embedded MCP Server at `http://127.0.0.1:49182/sse`) to safely review AI edits before writing to disk.

### ⚠️ CRITICAL RULES FOR AI AGENTS:
1. **DO NOT MODIFY SOURCE FILES DIRECTLY**: Never use native built-in `edit`, `write`, `create_file`, or terminal/shell commands (`echo >`, `cat >`, `sed`, `rm`, etc.) to alter code files.
2. **USE REVIEW HUB MCP TOOLS INSTEAD**:
   - `propose_edit` (or `mcp__review_hub__propose_edit`): Propose changing part of a file (`path`, `old_string`, `new_string`, optional `replace_all`).
   - `propose_write` (or `mcp__review_hub__propose_write`): Propose creating a new file or replacing entire content (`path`, `content`).
   - `propose_delete` (or `mcp__review_hub__propose_delete`): Propose deleting a file (`path`).
   - `read_file` (or `mcp__review_hub__read_file`): Read a file through the staged review state (`path`).
   - `list_changes` (or `mcp__review_hub__list_changes`): List pending changes awaiting review.
   - `get_change` (or `mcp__review_hub__get_change`): Inspect detailed hunks and unified diff.
3. **UNDERSTANDING STAGED STATE**:
   - A `propose_*` call returns `status: "staged_for_review"` with a `changeId`.
   - **This is SUCCESS, not an error.** The edit is staged in-memory for the developer to inspect and accept/reject individual hunks in their JetBrains IDE.
   - Review Hub does not write your edit to disk until accepted. Reading the file with native tools or disk inspection will show the OLD content — that is expected.
   - Always use the `read_file` MCP tool to inspect the content you have staged so far.
   - Do NOT retry with a different tool and do NOT attempt to force write to disk.
4. **FALLBACK**: Only fall back to built-in tools if Review Hub MCP explicitly returns an error indicating that the server is unreachable.
<!-- review-hub:end -->
