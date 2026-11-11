package com.reviewhub.mcp

import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import java.awt.*
import java.awt.datatransfer.StringSelection
import javax.swing.*
import javax.swing.border.CompoundBorder
import javax.swing.border.EmptyBorder
import javax.swing.border.LineBorder

class ConfigureMcpDialog(private val project: Project?) : DialogWrapper(project, true) {

    private var detectedTools: List<DetectedAiTool> = emptyList()
    private val checkBoxes = mutableMapOf<String, JBCheckBox>()
    private val rulesCheckBox = JBCheckBox("Also install AI Agent Rules (AGENTS.md, CLAUDE.md) in project root", true)
    private val itemsPanel = JPanel()

    init {
        title = "Configure AI Tools for Review Hub MCP"
        setOKButtonText("Apply & Save")
        init()
        rescan()
    }

    override fun createCenterPanel(): JComponent {
        val root = JPanel(BorderLayout(0, 10))
        root.preferredSize = Dimension(680, 520)

        // Top info header
        val headerPanel = JPanel(BorderLayout())
        headerPanel.border = EmptyBorder(0, 0, 6, 0)
        val titleLabel = JBLabel("Select AI CLI tools to enable Review Hub MCP integration:")
        titleLabel.font = titleLabel.font.deriveFont(Font.BOLD, 13f)
        headerPanel.add(titleLabel, BorderLayout.NORTH)

        val descLabel = JBLabel("Review Hub snapshots baselines safely and live-syncs AI edits to disk for builds while you review hunk-by-hunk.")
        descLabel.foreground = JBColor.GRAY
        headerPanel.add(descLabel, BorderLayout.SOUTH)

        // Utility toolbar (Select All Detected, Deselect All, Rescan, Add Custom Tool)
        val toolbarPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
        toolbarPanel.border = EmptyBorder(0, 0, 6, 0)

        val btnSelectDetected = JButton("Select Detected", AllIcons.Actions.Checked)
        btnSelectDetected.addActionListener {
            for (tool in detectedTools) {
                if (tool.isInstalled || tool.isRegistered) {
                    checkBoxes[tool.def.id]?.isSelected = true
                }
            }
        }

        val btnDeselectAll = JButton("Deselect All", AllIcons.Actions.Cancel)
        btnDeselectAll.addActionListener {
            for (cb in checkBoxes.values) {
                cb.isSelected = false
            }
        }

        val btnRescan = JButton("Rescan", AllIcons.Actions.Refresh)
        btnRescan.addActionListener {
            rescan()
        }

        val btnAddCustom = JButton("Add Custom Tool...", AllIcons.General.Add)
        btnAddCustom.addActionListener {
            val addDialog = AddCustomToolDialog(project)
            if (addDialog.showAndGet()) {
                rescan()
            }
        }

        toolbarPanel.add(btnSelectDetected)
        toolbarPanel.add(btnDeselectAll)
        toolbarPanel.add(btnRescan)
        toolbarPanel.add(btnAddCustom)

        val topCombined = JPanel(BorderLayout())
        topCombined.add(headerPanel, BorderLayout.NORTH)
        topCombined.add(toolbarPanel, BorderLayout.SOUTH)
        root.add(topCombined, BorderLayout.NORTH)

        // Scrollable list of AI tools
        itemsPanel.layout = BoxLayout(itemsPanel, BoxLayout.Y_AXIS)
        val scrollPane = JBScrollPane(itemsPanel)
        scrollPane.border = LineBorder(JBColor.border())
        root.add(scrollPane, BorderLayout.CENTER)

        // Bottom panel: Quick copy buttons & Agent Rules checkbox
        val bottomPanel = JPanel(BorderLayout(0, 8))
        bottomPanel.border = EmptyBorder(6, 0, 0, 0)

        val quickCopyPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
        val copyJsonBtn = JButton("Copy JSON Config", AllIcons.Actions.Copy)
        copyJsonBtn.toolTipText = "Copy MCP configuration for Claude, Cursor, Cline, Roo Code"
        copyJsonBtn.addActionListener {
            CopyPasteManager.getInstance().setContents(StringSelection(AiToolConfigManager.MCP_JSON_SNIPPET))
            Messages.showInfoMessage(project, "Review Hub JSON MCP config copied to clipboard!", "Review Hub MCP")
        }

        val copyTomlBtn = JButton("Copy TOML Config", AllIcons.Actions.Copy)
        copyTomlBtn.toolTipText = "Copy MCP configuration for OpenAI Codex CLI"
        copyTomlBtn.addActionListener {
            CopyPasteManager.getInstance().setContents(StringSelection(AiToolConfigManager.MCP_TOML_SNIPPET))
            Messages.showInfoMessage(project, "Review Hub TOML MCP config copied to clipboard!", "Review Hub MCP")
        }

        val copyCliBtn = JButton("Copy SSE URL", AllIcons.Actions.Copy)
        copyCliBtn.toolTipText = "Copy MCP SSE endpoint URL (http://127.0.0.1:49182/sse)"
        copyCliBtn.addActionListener {
            CopyPasteManager.getInstance().setContents(StringSelection(AiToolConfigManager.MCP_SSE_URL))
            Messages.showInfoMessage(project, "MCP SSE URL copied: ${AiToolConfigManager.MCP_SSE_URL}", "Review Hub MCP")
        }

        quickCopyPanel.add(copyJsonBtn)
        quickCopyPanel.add(copyTomlBtn)
        quickCopyPanel.add(copyCliBtn)

        bottomPanel.add(quickCopyPanel, BorderLayout.NORTH)
        bottomPanel.add(rulesCheckBox, BorderLayout.SOUTH)
        root.add(bottomPanel, BorderLayout.SOUTH)

        return root
    }

    private fun rescan() {
        detectedTools = AiToolScanner.scan(project?.basePath)
        rebuildListUI()
    }

    private fun rebuildListUI() {
        itemsPanel.removeAll()
        checkBoxes.clear()

        for (tool in detectedTools) {
            val itemRow = JPanel(BorderLayout(10, 0))
            itemRow.border = CompoundBorder(
                BorderLayoutLineBorder(JBColor.border(), 0, 0, 1, 0),
                EmptyBorder(8, 10, 8, 10)
            )

            val cb = JBCheckBox("", tool.isSelected)
            checkBoxes[tool.def.id] = cb

            val centerInfo = JPanel()
            centerInfo.layout = BoxLayout(centerInfo, BoxLayout.Y_AXIS)

            val nameLine = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
            nameLine.isOpaque = false

            val nameLabel = JBLabel(tool.def.name)
            nameLabel.font = nameLabel.font.deriveFont(Font.BOLD, 12f)
            nameLine.add(nameLabel)

            // Status Badge
            val (badgeText, badgeColor) = when {
                tool.isCustom -> Pair(" [Custom Tool] ", JBColor(Color(0x6D, 0x28, 0xD9), Color(0xA7, 0x8B, 0xFA)))
                tool.isRegistered -> Pair(" [Active / Configured] ", JBColor(Color(0x2E, 0x7D, 0x32), Color(0x4A, 0xDE, 0x80)))
                tool.isInstalled -> Pair(" [Detected] ", JBColor(Color(0x02, 0x77, 0xBD), Color(0x38, 0xBD, 0xF8)))
                else -> Pair(" [Not Installed] ", JBColor.GRAY)
            }
            val badgeLabel = JBLabel(badgeText)
            badgeLabel.font = badgeLabel.font.deriveFont(Font.BOLD, 10f)
            badgeLabel.foreground = badgeColor
            nameLine.add(badgeLabel)

            val reasonLabel = JBLabel("• ${tool.statusText}")
            reasonLabel.font = reasonLabel.font.deriveFont(11f)
            reasonLabel.foreground = JBColor.GRAY
            nameLine.add(reasonLabel)

            centerInfo.add(nameLine)

            val pathText = tool.configFile?.absolutePath ?: "Path unknown"
            val pathLabel = JBLabel(pathText)
            pathLabel.font = pathLabel.font.deriveFont(10f)
            pathLabel.foreground = JBColor.GRAY
            centerInfo.add(pathLabel)

            itemRow.add(cb, BorderLayout.WEST)
            itemRow.add(centerInfo, BorderLayout.CENTER)

            // Right side: delete button if custom tool
            if (tool.isCustom) {
                val deleteBtn = JButton(AllIcons.Actions.Cancel)
                deleteBtn.toolTipText = "Remove this custom tool"
                deleteBtn.isBorderPainted = false
                deleteBtn.isContentAreaFilled = false
                deleteBtn.preferredSize = Dimension(24, 24)
                deleteBtn.addActionListener {
                    val confirm = Messages.showYesNoDialog(
                        project,
                        "Remove custom tool '${tool.def.name}'?",
                        "Remove Custom Tool",
                        Messages.getQuestionIcon()
                    )
                    if (confirm == Messages.YES) {
                        AiToolScanner.removeCustomTool(tool.def.id)
                        rescan()
                    }
                }
                itemRow.add(deleteBtn, BorderLayout.EAST)
            }

            itemsPanel.add(itemRow)
        }

        itemsPanel.revalidate()
        itemsPanel.repaint()
    }

    override fun doOKAction() {
        for (tool in detectedTools) {
            val isChecked = checkBoxes[tool.def.id]?.isSelected == true
            tool.isSelected = isChecked
        }

        val basePath = project?.basePath
        val installRules = rulesCheckBox.isSelected && basePath != null

        val result = AiToolConfigManager.applyConfiguration(
            tools = detectedTools,
            installRules = installRules,
            basePath = basePath
        )

        super.doOKAction()

        val messages = mutableListOf<String>()
        if (result.updatedTools.isNotEmpty()) {
            messages.add("Enabled Review Hub MCP for:\n• " + result.updatedTools.joinToString("\n• "))
        }
        if (result.removedTools.isNotEmpty()) {
            messages.add("Removed Review Hub MCP from:\n• " + result.removedTools.joinToString("\n• "))
        }
        if (result.rulesInstalled.isNotEmpty()) {
            messages.add("Updated AI rules in:\n• " + result.rulesInstalled.joinToString(", "))
        }
        if (result.errors.isNotEmpty()) {
            messages.add("Warnings/Errors:\n• " + result.errors.joinToString("\n• "))
        }

        val fullMessage = if (messages.isEmpty()) {
            "No changes were made."
        } else {
            messages.joinToString("\n\n") + "\n\nRestart active AI tools/CLIs to pick up the changes."
        }

        try {
            val group = NotificationGroupManager.getInstance().getNotificationGroup("Review Hub")
            val notifType = if (result.errors.isEmpty()) NotificationType.INFORMATION else NotificationType.WARNING
            val notif = group.createNotification("Review Hub MCP Configuration", fullMessage, notifType)
            notif.notify(project)
        } catch (_: Exception) {
            Messages.showInfoMessage(project, fullMessage, "Review Hub MCP")
        }
    }

    private class BorderLayoutLineBorder(
        private val color: Color,
        private val top: Int,
        private val left: Int,
        private val bottom: Int,
        private val right: Int
    ) : LineBorder(color) {
        override fun paintBorder(c: Component, g: Graphics, x: Int, y: Int, width: Int, height: Int) {
            val oldColor = g.color
            g.color = color
            if (top > 0) g.fillRect(x, y, width, top)
            if (left > 0) g.fillRect(x, y, left, height)
            if (bottom > 0) g.fillRect(x, y + height - bottom, width, bottom)
            if (right > 0) g.fillRect(x + width - right, y, right, height)
            g.color = oldColor
        }
    }
}
