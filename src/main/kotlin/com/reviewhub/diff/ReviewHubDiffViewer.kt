package com.reviewhub.diff

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.reviewhub.core.HunkDiff
import com.reviewhub.hub.HubManager
import com.reviewhub.inline.ReviewHubInlineReview
import com.reviewhub.model.ChangeSummary
import java.io.File

object ReviewHubDiffViewer {
    fun showDiff(project: Project, summary: ChangeSummary) {
        val hubManager = project.getService(HubManager::class.java)
        val workspace = project.basePath ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val changeSet = hubManager.getChangeSet(summary.id, workspace)
            if (changeSet == null) {
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, "Could not fetch diff for ${summary.path}", "Review Hub")
                }
                return@executeOnPooledThread
            }

            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val factory = DiffContentFactory.getInstance()
                val fileType = FileTypeManager.getInstance().getFileTypeByFileName(changeSet.path)

                val stagedProposed = if (!changeSet.proposedExists) {
                    ""
                } else {
                    HunkDiff.resolveStaged(changeSet.baseline, changeSet.hunks)
                }

                val baselineContent = factory.create(project, changeSet.baseline, fileType)
                val proposedContent = factory.create(project, stagedProposed, fileType)

                val leftTitle = if (!changeSet.baselineExists) {
                    "Baseline (Did Not Exist)"
                } else {
                    "Baseline (Checkpoint Snapshot)"
                }
                val rightTitle = if (!changeSet.proposedExists) {
                    "Proposed (File Deleted by AI)"
                } else {
                    "Proposed (${changeSet.origin.uppercase()} Live Changes)"
                }

                val request = SimpleDiffRequest(
                    "Review Hub: ${changeSet.path}",
                    baselineContent,
                    proposedContent,
                    leftTitle,
                    rightTitle
                )

                val acceptAction = object : AnAction("Accept File", "Accept all pending changes in ${changeSet.path}", AllIcons.Actions.Checked) {
                    override fun actionPerformed(e: AnActionEvent) {
                        decideFromDiff(project, hubManager, workspace, changeSet.id, changeSet.path, accept = true)
                    }
                }
                val rejectAction = object : AnAction("Reject File", "Reject changes and restore baseline for ${changeSet.path}", AllIcons.Actions.Cancel) {
                    override fun actionPerformed(e: AnActionEvent) {
                        decideFromDiff(project, hubManager, workspace, changeSet.id, changeSet.path, accept = false)
                    }
                }
                request.putUserData(DiffUserDataKeys.CONTEXT_ACTIONS, listOf(acceptAction, rejectAction))

                DiffManager.getInstance().showDiff(project, request)
            }
        }
    }

    private fun decideFromDiff(
        project: Project,
        hubManager: HubManager,
        workspace: String,
        changeId: String,
        relPath: String,
        accept: Boolean
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            if (accept) {
                hubManager.acceptChange(changeId = changeId, workspace = workspace)
            } else {
                hubManager.rejectChange(changeId = changeId, workspace = workspace)
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val file = File(workspace, relPath)
                val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
                if (vf != null) {
                    if (!file.exists()) {
                        FileEditorManager.getInstance(project).closeFile(vf)
                        WriteCommandAction.runWriteCommandAction(project) {
                            try { if (vf.isValid) vf.delete(this) } catch (_: Exception) {}
                        }
                    } else if (vf.isValid) {
                        ReviewHubInlineReview.clearFileReview(project, vf)
                    }
                }
                VirtualFileManager.getInstance().asyncRefresh(null)
            }
        }
    }
}
