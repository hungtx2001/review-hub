package com.reviewhub.mcp

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.io.File
import java.util.UUID
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

class AddCustomToolDialog(project: Project?) : DialogWrapper(project, true) {

    private val nameField = JBTextField()
    private val pathField = TextFieldWithBrowseButton()
    private val formatCombo = JComboBox(arrayOf("JSON", "TOML"))

    init {
        title = "Add Custom AI Tool / CLI"
        init()

        pathField.addActionListener {
            val descriptor = FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor()
                .withTitle("Select AI Tool Configuration File")
                .withDescription("Choose a JSON or TOML config file for your AI CLI")
            val file = FileChooser.chooseFile(descriptor, project, null)
            if (file != null) {
                pathField.text = file.path
            }
        }
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(GridBagLayout())
        panel.preferredSize = Dimension(480, 140)
        val gbc = GridBagConstraints()
        gbc.insets = Insets(6, 6, 6, 6)
        gbc.fill = GridBagConstraints.HORIZONTAL

        // Row 0: Name
        gbc.gridx = 0
        gbc.gridy = 0
        gbc.weightx = 0.0
        panel.add(JBLabel("Tool Name:"), gbc)

        gbc.gridx = 1
        gbc.weightx = 1.0
        nameField.emptyText.text = "e.g., Goose, Gemini CLI, Aider, My In-house CLI"
        panel.add(nameField, gbc)

        // Row 1: File Path
        gbc.gridx = 0
        gbc.gridy = 1
        gbc.weightx = 0.0
        panel.add(JBLabel("Config File Path:"), gbc)

        gbc.gridx = 1
        gbc.weightx = 1.0
        panel.add(pathField, gbc)

        // Row 2: Format
        gbc.gridx = 0
        gbc.gridy = 2
        gbc.weightx = 0.0
        panel.add(JBLabel("Config Format:"), gbc)

        gbc.gridx = 1
        gbc.weightx = 1.0
        panel.add(formatCombo, gbc)

        return panel
    }

    override fun doOKAction() {
        val name = nameField.text.trim()
        val path = pathField.text.trim()

        if (name.isEmpty()) {
            Messages.showErrorDialog("Please enter a name for the custom tool.", "Validation Error")
            return
        }

        if (path.isEmpty()) {
            Messages.showErrorDialog("Please specify the path to the configuration file.", "Validation Error")
            return
        }

        val format = formatCombo.selectedItem as? String ?: "JSON"
        val customTool = CustomToolConfig(
            id = "custom-" + UUID.randomUUID().toString().take(8),
            name = name,
            filePath = File(path).absolutePath,
            format = format
        )

        AiToolScanner.saveCustomTool(customTool)
        super.doOKAction()
    }
}