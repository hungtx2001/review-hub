package com.reviewhub.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import com.reviewhub.mcp.AiToolConfigManager
import java.awt.datatransfer.StringSelection

class CopyMcpConfigAction : AnAction("Copy MCP Config for AI Tools") {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        CopyPasteManager.getInstance().setContents(StringSelection(AiToolConfigManager.MCP_JSON_SNIPPET))
        Messages.showInfoMessage(
            e.project,
            "Review Hub MCP configuration copied to clipboard!\n\nPaste it into Cursor, Codex, ~/.claude.json, Cline, or Roo Code to start reviewing edits.",
            "Review Hub MCP"
        )
    }
}
