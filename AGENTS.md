<!-- review-hub:start -->
## Review Hub
Edit files ONLY via `review-hub` MCP tools (`propose_edit`, `propose_write`, `propose_delete`); never built-in edit/write tools or shell redirects.
`staged_for_review` = success: changes are live-synced to disk (ready for build/test) with baseline snapshotted in the IDE for user review. Don't retry; use review-hub `read_file` to read files.
Use built-in tools only if the review-hub server is unreachable.
<!-- review-hub:end -->
