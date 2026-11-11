package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFileManager
import com.reviewhub.hub.HubManager
import com.reviewhub.inline.ReviewHubInlineReview

class RejectAllAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)

        if (!hubManager.hasPendingChanges) {
            Messages.showInfoMessage(project, "No pending changes to reject.", "Review Hub")
            return
        }

        val confirm = Messages.showYesNoDialog(
            project,
            "Are you sure you want to reject all pending changes and restore baseline on disk?",
            "Reject All Changes",
            Messages.getWarningIcon()
        )
        if (confirm != Messages.YES) return

        hubManager.rejectAll()
    }
}
