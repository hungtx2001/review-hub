<!-- review-hub:start -->
## Review Hub
Edit files ONLY via `review-hub` MCP tools (`propose_edit`, `propose_write`, `propose_delete`); never built-in edit/write tools or shell redirects.
`staged_for_review` = success: awaiting user approval in the IDE; disk still shows old content. Don't retry; read staged content via review-hub `read_file`.
Use built-in tools only if the review-hub server is unreachable.
<!-- review-hub:end -->