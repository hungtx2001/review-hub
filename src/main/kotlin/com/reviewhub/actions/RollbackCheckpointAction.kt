package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFileManager
import com.reviewhub.hub.HubManager
import com.reviewhub.inline.ReviewHubInlineReview

class RollbackCheckpointAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        val workspace = project.basePath ?: return

        val confirm = Messages.showYesNoDialog(
            project,
            "Are you sure you want to rollback all files in this workspace to the initial checkpoint state?\nAll accepted and pending AI changes will be undone.",
            "Rollback to Checkpoint",
            Messages.getWarningIcon()
        )
        if (confirm != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            val revertedFiles = hubManager.rollbackCheckpoint(workspace)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                VirtualFileManager.getInstance().asyncRefresh(null)
                hubManager.refresh()

                if (revertedFiles.isNotEmpty()) {
                    Messages.showInfoMessage(
                        project,
                        "Successfully reverted ${revertedFiles.size} file(s) to checkpoint baseline:\n${revertedFiles.joinToString("\n")}",
                        "Review Hub Rollback"
                    )
                } else {
                    Messages.showInfoMessage(project, "No checkpoint changes found to rollback.", "Review Hub Rollback")
                }
            }
        }
    }
}

