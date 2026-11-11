package com.reviewhub.inline

import com.intellij.icons.AllIcons
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil
import java.awt.*
import javax.swing.*

class ReviewHubHeaderBar(
    private val project: Project,
    private val editor: Editor,
    private val relPath: String,
    private val hunkCount: Int
) : JPanel(BorderLayout()) {

    init {
        border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor(Color(0xD0, 0xD7, 0xDE), Color(0x38, 0x3A, 0x42))),
            JBUI.Borders.empty(3, 8, 3, 8)
        )
        background = JBColor(Color(0xF6, 0xF8, 0xFA), Color(0x2B, 0x2D, 0x30))

        buildUI()
    }

    private fun buildUI() {
        val hubManager = project.getService(HubManager::class.java)
        val currentChange = hubManager.findChange(relPath)
        val pendingFiles = hubManager.changes.filter { it.status != "resolved" }
        val fileIndex = pendingFiles.indexOfFirst { PathUtil.pathsMatch(it.path, relPath) }

        // --- Left Panel: Action Buttons & Hunk Navigation ---
        val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 5, 0)).apply {
            isOpaque = false
        }

        val acceptFileBtn = createButton("Accept File", AllIcons.Actions.Checked, "Accept all changes in this file (Ctrl+Alt+A)") {
            ReviewHubInlineReview.decideCurrentFile(project, editor, "accept")
        }
        leftPanel.add(acceptFileBtn)

        val rejectFileBtn = createButton("Reject File", AllIcons.Actions.Cancel, "Reject all changes in this file and restore baseline (Ctrl+Alt+Z)") {
            ReviewHubInlineReview.decideCurrentFile(project, editor, "reject")
        }
        leftPanel.add(rejectFileBtn)

        if (hunkCount > 1) {
            val nextBtn = createButton("Next Hunk", AllIcons.Actions.MoveDown, "Jump to next pending change (Alt+Down)") {
                ReviewHubInlineReview.scrollToNextHunk(editor)
            }
            leftPanel.add(nextBtn)

            val prevBtn = createButton("Prev Hunk", AllIcons.Actions.MoveUp, "Jump to previous pending change (Alt+Up)") {
                ReviewHubInlineReview.scrollToPrevHunk(editor)
            }
            leftPanel.add(prevBtn)
        }

        val diffBtn = createButton("Diff", AllIcons.Actions.Diff, "Compare with baseline in side-by-side Diff Viewer") {
            val summary = currentChange ?: hubManager.findChange(relPath)
            if (summary != null) {
                ReviewHubDiffViewer.showDiff(project, summary)
            }
        }
        leftPanel.add(diffBtn)

        if (pendingFiles.size > 1) {
            val prevFileBtn = createButton("Prev File", AllIcons.Actions.Back, "Open previous pending file") {
                val prevIdx = if (fileIndex > 0) fileIndex - 1 else pendingFiles.size - 1
                ReviewHubInlineReview.openReviewFile(project, pendingFiles[prevIdx].path)
            }
            leftPanel.add(prevFileBtn)

            val nextFileBtn = createButton("Next File", AllIcons.Actions.Forward, "Open next pending file") {
                val nextIdx = if (fileIndex in 0 until pendingFiles.size - 1) fileIndex + 1 else 0
                ReviewHubInlineReview.openReviewFile(project, pendingFiles[nextIdx].path)
            }
            leftPanel.add(nextFileBtn)

            val acceptAllBtn = createButton("Accept All (${pendingFiles.size})", AllIcons.Actions.Commit, "Accept all pending files in workspace") {
                hubManager.acceptAll()
            }
            leftPanel.add(acceptAllBtn)
        }

        add(leftPanel, BorderLayout.WEST)

        // --- Right Panel: Status & Shortcuts Hint ---
        val rightPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 2)).apply {
            isOpaque = false
        }

        val fileBadge = if (pendingFiles.size > 1 && fileIndex >= 0) {
            "File ${fileIndex + 1}/${pendingFiles.size}  •  "
        } else {
            ""
        }

        val statusBadge = JBLabel("${fileBadge}$hunkCount pending  •  Alt+A Accept Hunk  Alt+R Reject Hunk").apply {
            font = font.deriveFont(11f)
            foreground = ReviewHubInlineReview.SEPARATOR_COLOR
        }
        rightPanel.add(statusBadge)
        add(rightPanel, BorderLayout.EAST)
    }

    private fun createButton(text: String, icon: Icon?, tooltip: String, onClick: () -> Unit): JButton {
        return JButton(text, icon).apply {
            isFocusable = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            toolTipText = tooltip
            margin = JBUI.insets(2, 6)
            font = font.deriveFont(11f)
            addActionListener { onClick() }
        }
    }
}
