package com.reviewhub.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFileManager
import com.reviewhub.hub.HubManager
import com.reviewhub.inline.ReviewHubInlineReview

class ClearCheckpointAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        val workspace = project.basePath ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val ok = hubManager.clearCheckpoint(workspace)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (ok) {
                    ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                    VirtualFileManager.getInstance().asyncRefresh(null)
                    Messages.showInfoMessage(project, "Checkpoint cleared.", "Review Hub")
                } else {
                    Messages.showErrorDialog(project, "Failed to clear checkpoint.", "Review Hub")
                }
            }
        }
    }
}
