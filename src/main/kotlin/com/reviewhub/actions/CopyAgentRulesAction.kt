package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import com.reviewhub.mcp.AiToolConfigManager
import java.awt.datatransfer.StringSelection

class CopyAgentRulesAction : AnAction("Copy AI Agent Rules") {
    override fun actionPerformed(e: AnActionEvent) {
        CopyPasteManager.getInstance().setContents(StringSelection(AiToolConfigManager.AGENT_RULES_CONTENT))
        Messages.showInfoMessage(
            e.project,
            "Review Hub AI agent rules copied to clipboard!\n\nPaste into CLAUDE.md, .cursorrules, .clinerules, or AGENTS.md in your project root.",
            "Review Hub AI Rules"
        )
    }
}

