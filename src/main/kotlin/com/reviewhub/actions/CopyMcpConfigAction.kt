package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.StringSelection

class CopyMcpConfigAction : AnAction("Copy MCP Config for AI Tools") {
    override fun actionPerformed(e: AnActionEvent) {
        val config = """
        {
          "mcpServers": {
            "review-hub": {
              "command": "npx",
              "args": ["-y", "review-hub-mcp"]
            }
          }
        }
        """.trimIndent()

        CopyPasteManager.getInstance().setContents(StringSelection(config))
        Messages.showInfoMessage(
            e.project,
            "Review Hub MCP configuration copied to clipboard!\n\nPaste it into ~/.claude.json, Cline, or Roo Code to start reviewing edits.",
            "Review Hub MCP"
        )
    }
}

