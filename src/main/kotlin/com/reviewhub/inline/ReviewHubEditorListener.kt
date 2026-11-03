package com.reviewhub.inline

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.vfs.VirtualFile
import com.reviewhub.util.PathUtil

class ReviewHubEditorListener : FileEditorManagerListener {
    override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
        ApplicationManager.getApplication().invokeLater {
            update(source, file)
        }
    }

    override fun selectionChanged(event: FileEditorManagerEvent) {
        val file = event.newFile ?: return
        ApplicationManager.getApplication().invokeLater {
            update(event.manager, file)
        }
    }

    override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
        val project = source.project
        val editor = (source.getSelectedEditor(file) as? TextEditor)?.editor
        if (editor != null && !editor.isDisposed) {
            ReviewHubInlineReview.clear(project, editor, file)
        }
    }

    private fun update(manager: FileEditorManager, file: VirtualFile) {
        val project = manager.project
        val relPath = PathUtil.toRelativePath(project, file) ?: return
        val editor = (manager.getSelectedEditor(file) as? TextEditor)?.editor
            ?: manager.selectedTextEditor
            ?: return

        ReviewHubInlineReview.updateInlays(project, editor, relPath)
    }
}
