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

