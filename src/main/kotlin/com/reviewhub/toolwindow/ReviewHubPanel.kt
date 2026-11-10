package com.reviewhub.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.JBMenuItem
import com.intellij.openapi.ui.JBPopupMenu
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import com.reviewhub.inline.ReviewHubInlineReview
import com.reviewhub.model.ChangeSummary
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder

class ReviewHubPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {
    companion object {
        private val GREEN_ATTR = SimpleTextAttributes(
            SimpleTextAttributes.STYLE_BOLD,
            JBColor(Color(0x2E, 0x7D, 0x32), Color(0x4A, 0xDE, 0x80))
        )
        private val RED_ATTR = SimpleTextAttributes(
            SimpleTextAttributes.STYLE_BOLD,
            JBColor(Color(0xC6, 0x28, 0x28), Color(0xF8, 0x71, 0x71))
        )
        private val STRIKEOUT_ATTR = SimpleTextAttributes(
            SimpleTextAttributes.STYLE_STRIKEOUT,
            JBColor(Color(0x8C, 0x95, 0x9F), Color(0x8B, 0x94, 0x9E))
        )
    }

    private val hubManager = project.getService(HubManager::class.java)
    private val listModel = DefaultListModel<ChangeSummary>()
    private val changeList = JBList(listModel)
    private val statusLabel = JLabel("Ready")
    private val quickActionsPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 4, 0)).apply { isOpaque = false }

    init {
        setupToolbar()
        setupUI()
        setupListeners()
        refreshList()
    }

    private fun setupToolbar() {
        val actionManager = ActionManager.getInstance()
        val group = actionManager.getAction("ReviewHub.ToolBar") as? DefaultActionGroup
            ?: DefaultActionGroup()
        val toolbar = actionManager.createActionToolbar("ReviewHubToolbar", group, true)
        toolbar.targetComponent = this
        setToolbar(toolbar.component)
    }

    private fun setupUI() {
        changeList.cellRenderer = object : ColoredListCellRenderer<ChangeSummary>() {
            override fun customizeCellRenderer(
                list: JList<out ChangeSummary>,
                value: ChangeSummary?,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean
            ) {
                if (value == null) return

                val ioFile = File(value.path)
                val fileName = ioFile.name
                val dirPath = ioFile.parent?.replace('\\', '/')

                icon = when {
                    value.status == "applied" -> AllIcons.Actions.Commit
                    !value.proposedExists -> AllIcons.Actions.GC
                    else -> FileTypeManager.getInstance().getFileTypeByFileName(fileName).icon
                        ?: AllIcons.FileTypes.Any_type
                }

                if (!value.proposedExists) {
                    append(fileName, STRIKEOUT_ATTR)
                    append("  [DELETED]", RED_ATTR)
                } else {
                    append(fileName, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    if (!value.baselineExists) {
                        append("  [NEW]", GREEN_ATTR)
                    }
                }

                if (!dirPath.isNullOrEmpty()) {
                    append("  $dirPath", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }

                if (value.added > 0 || value.removed > 0) {
                    append("  ")
                    if (value.added > 0) {
                        append("+${value.added}", GREEN_ATTR)
                    }
                    if (value.added > 0 && value.removed > 0) {
                        append(" ")
                    }
                    if (value.removed > 0) {
                        append("-${value.removed}", RED_ATTR)
                    }
                }

                if (value.pending > 0) {
                    append("  (${value.pending})", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
                }

                toolTipText = "${value.path} (+${value.added} -${value.removed}, ${value.pending} pending hunk(s)) — Left-click: Open | Space: Diff | Alt+A: Accept | Del: Reject"
            }
        }

        changeList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val index = changeList.locationToIndex(e.point)
                if (index < 0) return
                changeList.selectedIndex = index
                val selected = changeList.selectedValue ?: return

                if (SwingUtilities.isLeftMouseButton(e)) {
                    openRealFile(selected)
                } else if (SwingUtilities.isRightMouseButton(e)) {
                    showContextMenu(e, selected)
                }
            }
        })

        changeList.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                val selected = changeList.selectedValue ?: return
                when {
                    e.keyCode == KeyEvent.VK_ENTER -> {
                        e.consume()
                        openRealFile(selected)
                    }
                    e.keyCode == KeyEvent.VK_SPACE -> {
                        e.consume()
                        ReviewHubDiffViewer.showDiff(project, selected)
                    }
                    e.isAltDown && e.keyCode == KeyEvent.VK_A -> {
                        e.consume()
                        acceptSingleItem(selected)
                    }
                    (e.isAltDown && e.keyCode == KeyEvent.VK_R) ||
                        e.keyCode == KeyEvent.VK_DELETE ||
                        e.keyCode == KeyEvent.VK_BACK_SPACE -> {
                        e.consume()
                        rejectSingleItem(selected)
                    }
                }
            }
        })

        changeList.emptyText.text = "No pending changes"
        changeList.emptyText.appendLine("AI edits are live-synced to disk for builds & staged here for review.", SimpleTextAttributes.GRAYED_ATTRIBUTES, null)

        val contentPanel = JPanel(BorderLayout())
        contentPanel.add(JBScrollPane(changeList), BorderLayout.CENTER)

        val acceptAllBtn = JButton("Accept All", AllIcons.Actions.Checked).apply {
            isFocusable = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            font = font.deriveFont(11f)
            toolTipText = "Accept all pending files in workspace"
            addActionListener { hubManager.acceptAll() }
        }
        val rejectAllBtn = JButton("Reject All", AllIcons.Actions.Cancel).apply {
            isFocusable = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            font = font.deriveFont(11f)
            toolTipText = "Reject all pending files and restore baseline"
            addActionListener {
                val confirm = Messages.showYesNoDialog(
                    project,
                    "Reject all pending changes and restore baseline on disk?",
                    "Reject All Changes",
                    Messages.getWarningIcon()
                )
                if (confirm == Messages.YES) {
                    hubManager.rejectAll()
                }
            }
        }
        quickActionsPanel.add(acceptAllBtn)
        quickActionsPanel.add(rejectAllBtn)
        quickActionsPanel.isVisible = false

        val bottomPanel = JPanel(BorderLayout())
        bottomPanel.border = EmptyBorder(6, 10, 6, 10)
        bottomPanel.add(statusLabel, BorderLayout.WEST)
        bottomPanel.add(quickActionsPanel, BorderLayout.EAST)
        contentPanel.add(bottomPanel, BorderLayout.SOUTH)

        setContent(contentPanel)
    }

    private fun openRealFile(item: ChangeSummary) {
        ReviewHubInlineReview.openReviewFile(project, item.path)
    }

    private fun acceptSingleItem(item: ChangeSummary) {
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            hubManager.acceptChange(changeId = item.id, workspace = workspace)
            hubManager.refresh()
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val file = File(workspace, item.path)
                val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
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

    private fun rejectSingleItem(item: ChangeSummary) {
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            hubManager.rejectChange(changeId = item.id, workspace = workspace)
            hubManager.refresh()
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val file = File(workspace, item.path)
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

    private fun showContextMenu(e: MouseEvent, item: ChangeSummary) {
        val menu = JBPopupMenu()

        val openItem = JBMenuItem(if (!item.proposedExists) "Inspect Deleted File (Diff)" else "Open in Editor", AllIcons.Actions.Edit)
        openItem.addActionListener {
            openRealFile(item)
        }
        menu.add(openItem)

        val diffItem = JBMenuItem("Compare with Baseline (Diff)", AllIcons.Actions.Diff)
        diffItem.addActionListener {
            ReviewHubDiffViewer.showDiff(project, item)
        }
        menu.add(diffItem)

        menu.addSeparator()

        val acceptItem = JBMenuItem("Accept File (Alt+A)", AllIcons.Actions.Checked)
        acceptItem.addActionListener {
            acceptSingleItem(item)
        }
        menu.add(acceptItem)

        val rejectItem = JBMenuItem("Reject File (Del)", AllIcons.Actions.Cancel)
        rejectItem.addActionListener {
            rejectSingleItem(item)
        }
        menu.add(rejectItem)

        menu.addSeparator()

        val acceptAllItem = JBMenuItem("Accept All Changes", AllIcons.Actions.Checked)
        acceptAllItem.addActionListener {
            val confirm = Messages.showYesNoDialog(
                project,
                "Accept all pending changes in workspace?",
                "Accept All",
                Messages.getQuestionIcon()
            )
            if (confirm == Messages.YES) {
                hubManager.acceptAll()
            }
        }
        menu.add(acceptAllItem)

        val rejectAllItem = JBMenuItem("Reject All Changes", AllIcons.Actions.Cancel)
        rejectAllItem.addActionListener {
            val confirm = Messages.showYesNoDialog(
                project,
                "Reject all pending changes and restore baseline on disk?",
                "Reject All",
                Messages.getWarningIcon()
            )
            if (confirm == Messages.YES) {
                hubManager.rejectAll()
            }
        }
        menu.add(rejectAllItem)

        menu.addSeparator()

        val am = ActionManager.getInstance()
        listOf(
            "ReviewHub.RollbackCheckpoint",
            "ReviewHub.CopyMcpConfig",
            "ReviewHub.CopyAgentRules",
            "ReviewHub.RegisterMcp",
        ).forEach { actionId ->
            val act = am.getAction(actionId)
            if (act != null) {
                val menuItem = JBMenuItem(act.templatePresentation.text)
                menuItem.addActionListener {
                    am.tryToExecute(act, e, changeList, "ReviewHubContextMenu", true)
                }
                menu.add(menuItem)
            }
        }

        menu.show(changeList, e.x, e.y)
    }

    private fun setupListeners() {
        hubManager.addChangeListener {
            ApplicationManager.getApplication().invokeLater {
                refreshList()
            }
        }
    }

    fun refreshList() {
        listModel.clear()
        val list = hubManager.changes
        for (item in list) {
            listModel.addElement(item)
        }

        quickActionsPanel.isVisible = list.isNotEmpty()

        if (hubManager.client == null) {
            statusLabel.text = "Review Hub: Connecting..."
            statusLabel.icon = AllIcons.General.Warning
        } else if (list.isEmpty()) {
            statusLabel.text = "Review Hub: Active (0 pending changes)"
            statusLabel.icon = AllIcons.General.InspectionsOK
        } else {
            val totalHunks = list.sumOf { it.pending }
            statusLabel.text = "${list.size} file(s), $totalHunks pending"
            statusLabel.icon = AllIcons.Actions.Diff
        }
    }
}
