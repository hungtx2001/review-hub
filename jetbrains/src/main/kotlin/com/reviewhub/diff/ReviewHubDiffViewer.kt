package com.reviewhub.diff

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.reviewhub.hub.HubManager
import com.reviewhub.model.ChangeSummary

object ReviewHubDiffViewer {
    fun showDiff(project: Project, summary: ChangeSummary) {
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client
        val workspace = project.basePath ?: return

        if (client == null) {
            Messages.showErrorDialog(project, "Review Hub is not connected.", "Review Hub")
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            val changeSet = client.getChange(summary.id, workspace)
            if (changeSet == null) {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, "Could not fetch diff for ${summary.path}", "Review Hub")
                }
                return@executeOnPooledThread
            }

            ApplicationManager.getApplication().invokeLater {
                val factory = DiffContentFactory.getInstance()
                val fileType = FileTypeManager.getInstance().getFileTypeByFileName(changeSet.path)

                val baselineContent = factory.create(project, changeSet.baseline, fileType)
                val proposedContent = factory.create(project, changeSet.proposed, fileType)

                val request = SimpleDiffRequest(
                    "Review Hub: ${changeSet.path}",
                    baselineContent,
                    proposedContent,
                    "Baseline (Checkpoint / On Disk)",
                    "Proposed (${changeSet.origin.uppercase()} Agent Changes)"
                )

                DiffManager.getInstance().showDiff(project, request)
            }
        }
    }
}
