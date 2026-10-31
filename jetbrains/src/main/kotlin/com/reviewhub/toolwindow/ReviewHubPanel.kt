package com.reviewhub.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
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
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.DefaultListModel
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
    }

    private val hubManager = project.getService(HubManager::class.java)
    private val listModel = DefaultListModel<ChangeSummary>()
    private val changeList = JBList(listModel)
    private val statusLabel = JLabel("Ready")

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

                icon = if (value.status == "applied") AllIcons.Actions.Commit else AllIcons.FileTypes.Any_type

                append(value.path, SimpleTextAttributes.REGULAR_ATTRIBUTES)

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

        changeList.emptyText.text = "No pending changes"
        changeList.emptyText.appendLine("Edits proposed by AI coding agents will appear here for review.", SimpleTextAttributes.GRAYED_ATTRIBUTES, null)

        val contentPanel = JPanel(BorderLayout())
        contentPanel.add(JBScrollPane(changeList), BorderLayout.CENTER)

        val bottomPanel = JPanel(BorderLayout())
        bottomPanel.border = EmptyBorder(6, 10, 6, 10)
        bottomPanel.add(statusLabel, BorderLayout.WEST)
        contentPanel.add(bottomPanel, BorderLayout.SOUTH)

        setContent(contentPanel)
    }

    private fun openRealFile(item: ChangeSummary) {
        val basePath = project.basePath ?: return
        val file = File(basePath, item.path)
        val lfs = LocalFileSystem.getInstance()
        val vf = lfs.refreshAndFindFileByIoFile(file) ?: lfs.findFileByIoFile(file)
        if (vf != null) {
            FileEditorManager.getInstance(project).openFile(vf, true)
            return
        }

        // New file that does not exist on disk yet:
        // Materialize it on disk with proposed content so it opens as a real file
        ApplicationManager.getApplication().executeOnPooledThread {
            val client = hubManager.client ?: return@executeOnPooledThread
            val content = client.getChange(item.id, basePath)?.proposed ?: ""
            try {
                file.parentFile?.mkdirs()
                file.writeText(content)
            } catch (_: Exception) {
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val createdVf = lfs.refreshAndFindFileByIoFile(file)
                if (createdVf != null) {
                    FileEditorManager.getInstance(project).openFile(createdVf, true)
                }
                VirtualFileManager.getInstance().asyncRefresh(null)
            }
        }
    }

    private fun showContextMenu(e: MouseEvent, item: ChangeSummary) {
        val menu = JBPopupMenu()

        val openItem = JBMenuItem("Open in Editor", AllIcons.Actions.Edit)
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

        val acceptItem = JBMenuItem("Accept File", AllIcons.Actions.Checked)
        acceptItem.addActionListener {
            val client = hubManager.client ?: return@addActionListener
            val workspace = project.basePath ?: return@addActionListener
            ApplicationManager.getApplication().executeOnPooledThread {
                client.accept(changeId = item.id, workspace = workspace)
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    val file = File(workspace, item.path)
                    val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                    if (vf != null && vf.isValid) {
                        ReviewHubInlineReview.clearFileReview(project, vf)
                    }
                    VirtualFileManager.getInstance().asyncRefresh(null)
                }
            }
        }
        menu.add(acceptItem)

        val rejectItem = JBMenuItem("Reject File", AllIcons.Actions.Cancel)
        rejectItem.addActionListener {
            val client = hubManager.client ?: return@addActionListener
            val workspace = project.basePath ?: return@addActionListener
            ApplicationManager.getApplication().executeOnPooledThread {
                client.reject(changeId = item.id, workspace = workspace)
                hubManager.refresh()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    val file = File(workspace, item.path)
                    val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                    if (vf != null && vf.isValid) {
                        ReviewHubInlineReview.clearFileReview(project, vf)
                    }
                    VirtualFileManager.getInstance().asyncRefresh(null)
                }
            }
        }
        menu.add(rejectItem)

        menu.addSeparator()

        val acceptAllItem = JBMenuItem("Accept All Changes", AllIcons.Actions.Checked)
        acceptAllItem.addActionListener {
            val client = hubManager.client ?: return@addActionListener
            val workspace = project.basePath ?: return@addActionListener
            val confirm = Messages.showYesNoDialog(
                project,
                "Accept all pending changes and write them to disk?",
                "Accept All",
                Messages.getQuestionIcon()
            )
            if (confirm == Messages.YES) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    for (c in hubManager.changes) {
                        client.accept(changeId = c.id, workspace = workspace)
                    }
                    hubManager.refresh()
                    ApplicationManager.getApplication().invokeLater {
                        if (project.isDisposed) return@invokeLater
                        ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                        VirtualFileManager.getInstance().asyncRefresh(null)
                    }
                }
            }
        }
        menu.add(acceptAllItem)

        val rejectAllItem = JBMenuItem("Reject All Changes", AllIcons.Actions.Cancel)
        rejectAllItem.addActionListener {
            val client = hubManager.client ?: return@addActionListener
            val workspace = project.basePath ?: return@addActionListener
            val confirm = Messages.showYesNoDialog(
                project,
                "Reject all pending changes and restore baseline?",
                "Reject All",
                Messages.getWarningIcon()
            )
            if (confirm == Messages.YES) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    for (c in hubManager.changes) {
                        client.reject(changeId = c.id, workspace = workspace)
                    }
                    hubManager.refresh()
                    ApplicationManager.getApplication().invokeLater {
                        if (project.isDisposed) return@invokeLater
                        ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                        VirtualFileManager.getInstance().asyncRefresh(null)
                    }
                }
            }
        }
        menu.add(rejectAllItem)

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
