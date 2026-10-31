package com.reviewhub.inline

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil
import java.awt.*
import java.io.File
import javax.swing.*

class ReviewHubHeaderBar(
    private val project: Project,
    private val editor: Editor,
    private val relPath: String
) : JPanel(BorderLayout()) {

    init {
        border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor(Color(0xD0, 0xD7, 0xDE), Color(0x30, 0x36, 0x3D))),
            JBUI.Borders.empty(4, 10, 4, 10)
        )
        background = JBColor(Color(0xF6, 0xF8, 0xFA), Color(0x21, 0x26, 0x2D))

        buildUI()
    }

    private fun buildUI() {
        val hubManager = project.getService(HubManager::class.java)
        val basePath = project.basePath ?: return
        val currentChange = hubManager.findChange(relPath)
        val pendingFiles = hubManager.changes.filter { it.status == "pending" }
        val fileIndex = pendingFiles.indexOfFirst { PathUtil.pathsMatch(it.path, relPath) }

        // --- Left Panel: Logo, File Selector, Hunk Counter ---
        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
            isOpaque = false
        }

        val logoLabel = JBLabel("Review Hub", AllIcons.Actions.Diff, SwingConstants.LEFT).apply {
            font = font.deriveFont(Font.BOLD, 12f)
            foreground = JBColor(Color(0x24, 0x29, 0x2F), Color(0xF0, 0xF6, 0xFC))
        }
        leftPanel.add(logoLabel)

        if (pendingFiles.size > 1) {
            val fileChoices = pendingFiles.map { "${it.path} (${it.pending})" }.toTypedArray()
            val combo = JComboBox(fileChoices).apply {
                selectedIndex = if (fileIndex >= 0) fileIndex else 0
                isFocusable = false
                addActionListener {
                    val selectedIdx = selectedIndex
                    if (selectedIdx in pendingFiles.indices && selectedIdx != fileIndex) {
                        openFile(project, pendingFiles[selectedIdx].path)
                    }
                }
            }
            leftPanel.add(combo)

            val counterLabel = JBLabel("File ${fileIndex + 1} of ${pendingFiles.size}").apply {
                foreground = JBColor(Color(0x57, 0x60, 0x6A), Color(0x8B, 0x94, 0x9E))
            }
            leftPanel.add(counterLabel)
        } else {
            val fileLabel = JBLabel(relPath).apply {
                font = font.deriveFont(Font.BOLD, 12f)
            }
            leftPanel.add(fileLabel)
        }

        val hunksPending = currentChange?.pending ?: 0
        val hunksLabel = JBLabel("•  $hunksPending pending").apply {
            foreground = JBColor(Color(0x57, 0x60, 0x6A), Color(0x8B, 0x94, 0x9E))
        }
        leftPanel.add(hunksLabel)

        add(leftPanel, BorderLayout.WEST)

        // --- Right Panel: Navigation and Actions ---
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 6, 0)).apply {
            isOpaque = false
        }

        // Navigation buttons (Antigravity-style)
        if (pendingFiles.size > 1) {
            val prevBtn = createButton("◀ Prev File", null) {
                val prevIdx = if (fileIndex > 0) fileIndex - 1 else pendingFiles.size - 1
                openFile(project, pendingFiles[prevIdx].path)
            }
            rightPanel.add(prevBtn)

            val nextBtn = createButton("Next File ▶", null) {
                val nextIdx = if (fileIndex in 0 until pendingFiles.size - 1) fileIndex + 1 else 0
                openFile(project, pendingFiles[nextIdx].path)
            }
            rightPanel.add(nextBtn)
        }

        if (hunksPending > 1) {
            val nextHunkBtn = createButton("▼ Next", null) {
                ReviewHubInlineReview.scrollToNextHunk(editor)
            }
            rightPanel.add(nextHunkBtn)
        }

        // Action buttons
        val acceptFileBtn = createButton("Accept File", AllIcons.Actions.Checked) {
            if (currentChange == null) return@createButton
            val client = hubManager.client ?: return@createButton
            ApplicationManager.getApplication().executeOnPooledThread {
                client.accept(changeId = currentChange.id, workspace = basePath)
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    val file = File(basePath, relPath)
                    val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                    if (vf != null && vf.isValid) {
                        ReviewHubInlineReview.clearFileReview(project, vf)
                    }
                    VirtualFileManager.getInstance().asyncRefresh(null)
                    val remaining = hubManager.changes.filter { it.status == "pending" && it.id != currentChange.id }
                    if (remaining.isNotEmpty()) {
                        openFile(project, remaining.first().path)
                    }
                }
            }
        }
        rightPanel.add(acceptFileBtn)

        val rejectFileBtn = createButton("Reject File", AllIcons.Actions.Cancel) {
            if (currentChange == null) return@createButton
            val client = hubManager.client ?: return@createButton
            ApplicationManager.getApplication().executeOnPooledThread {
                client.reject(changeId = currentChange.id, workspace = basePath)
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    val file = File(basePath, relPath)
                    val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                    if (vf != null && vf.isValid) {
                        ReviewHubInlineReview.clearFileReview(project, vf)
                    }
                    VirtualFileManager.getInstance().asyncRefresh(null)
                    val remaining = hubManager.changes.filter { it.status == "pending" && it.id != currentChange.id }
                    if (remaining.isNotEmpty()) {
                        openFile(project, remaining.first().path)
                    }
                }
            }
        }
        rightPanel.add(rejectFileBtn)

        if (pendingFiles.size > 1) {
            val acceptAllBtn = createButton("Accept All", AllIcons.Actions.Commit) {
                val client = hubManager.client ?: return@createButton
                ApplicationManager.getApplication().executeOnPooledThread {
                    for (c in pendingFiles) {
                        client.accept(changeId = c.id, workspace = basePath)
                    }
                    hubManager.refresh()
                    ApplicationManager.getApplication().invokeLater {
                        if (project.isDisposed) return@invokeLater
                        ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                        VirtualFileManager.getInstance().asyncRefresh(null)
                    }
                }
            }
            rightPanel.add(acceptAllBtn)
        }

        val diffBtn = createButton("Diff", AllIcons.Actions.Diff) {
            if (currentChange != null) {
                ReviewHubDiffViewer.showDiff(project, currentChange)
            }
        }
        rightPanel.add(diffBtn)

        add(rightPanel, BorderLayout.EAST)
    }

    private fun createButton(text: String, icon: Icon?, onClick: () -> Unit): JButton {
        return JButton(text, icon).apply {
            isFocusable = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            margin = JBUI.insets(2, 7)
            font = font.deriveFont(11f)
            addActionListener { onClick() }
        }
    }

    private fun openFile(project: Project, targetRelPath: String) {
        val basePath = project.basePath ?: return
        val ioFile = File(basePath, targetRelPath)
        val vf = LocalFileSystem.getInstance().findFileByIoFile(ioFile) ?: return
        FileEditorManager.getInstance(project).openFile(vf, true)
    }
}

