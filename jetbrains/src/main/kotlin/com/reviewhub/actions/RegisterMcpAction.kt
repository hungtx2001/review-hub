package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.reviewhub.mcp.ConfigureMcpDialog

class RegisterMcpAction : AnAction("Configure AI Tools (MCP)...") {
    override fun actionPerformed(e: AnActionEvent) {
        val dialog = ConfigureMcpDialog(e.project)
        dialog.show()
    }
}
