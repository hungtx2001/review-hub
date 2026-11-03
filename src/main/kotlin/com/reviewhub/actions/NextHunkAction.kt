package com.reviewhub.actions

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor
import com.reviewhub.inline.ReviewHubInlineReview

class NextHunkAction : AnAction("Next Change", "Navigate to next pending change", AllIcons.Actions.MoveDown) {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
            ?: (FileEditorManager.getInstance(project).selectedEditor as? TextEditor)?.editor
            ?: return
        ReviewHubInlineReview.scrollToNextHunk(editor)
    }

    override fun update(e: AnActionEvent) {
        val project = e.project
        val editor = e.getData(CommonDataKeys.EDITOR)
            ?: (project?.let { FileEditorManager.getInstance(it).selectedEditor as? TextEditor })?.editor
        e.presentation.isEnabled = editor != null && ReviewHubInlineReview.hasPendingHunks(editor)
    }
}
