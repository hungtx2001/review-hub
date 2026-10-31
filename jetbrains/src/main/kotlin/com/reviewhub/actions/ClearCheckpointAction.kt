package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFileManager
import com.reviewhub.hub.HubManager

class ClearCheckpointAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client ?: return
        val workspace = project.basePath ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val ok = client.clearCheckpoint(workspace)
            ApplicationManager.getApplication().invokeLater {
                if (ok) {
                    hubManager.refresh()
                    VirtualFileManager.getInstance().asyncRefresh(null)
                    Messages.showInfoMessage(project, "Checkpoint cleared.", "Review Hub")
                } else {
                    Messages.showErrorDialog(project, "Failed to clear checkpoint.", "Review Hub")
                }
            }
        }
    }
}
