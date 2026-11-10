package com.reviewhub.status

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.ClickListener
import com.intellij.util.ui.JBUI
import com.reviewhub.hub.HubManager
import java.awt.Cursor
import java.awt.event.MouseEvent
import javax.swing.JComponent
import javax.swing.JLabel

class ReviewHubStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = ID
    override fun getDisplayName(): String = "Review Hub"
    override fun isAvailable(project: Project): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = ReviewHubStatusBarWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) {
        widget.dispose()
    }
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true

    companion object {
        const val ID = "ReviewHubStatusBarWidget"
    }
}

class ReviewHubStatusBarWidget(private val project: Project) : CustomStatusBarWidget {
    private var myStatusBar: StatusBar? = null
    private val label = JLabel()
    private val hubManager = project.getService(HubManager::class.java)
    private val changeListener: () -> Unit = {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) {
                updateStatus()
                myStatusBar?.updateWidget(ID())
            }
        }
    }

    init {
        label.border = JBUI.Borders.empty(0, 4)
        label.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        updateStatus()

        object : ClickListener() {
            override fun onClick(event: MouseEvent, clickCount: Int): Boolean {
                if (event.button == MouseEvent.BUTTON1) {
                    val tw = ToolWindowManager.getInstance(project).getToolWindow("Review Hub")
                    if (tw != null) {
                        if (tw.isVisible) {
                            tw.hide(null)
                        } else {
                            tw.activate(null)
                        }
                    }
                    return true
                }
                return false
            }
        }.installOn(label)

        hubManager.addChangeListener(changeListener)
    }

    private fun updateStatus() {
        val changes = hubManager.changes
        if (changes.isEmpty()) {
            label.text = "Review Hub: Ready"
            label.icon = AllIcons.General.InspectionsOK
            label.toolTipText = "Review Hub: Ready for AI suggestions. Click to toggle panel."
        } else {
            val totalPending = changes.sumOf { it.pending }
            label.text = "Review Hub: ${changes.size} file(s), $totalPending pending"
            label.icon = AllIcons.Actions.Diff
            label.toolTipText = "Review Hub: $totalPending pending change(s) across ${changes.size} file(s). Click to review."
        }
    }

    override fun ID(): String = ReviewHubStatusBarWidgetFactory.ID
    override fun install(statusBar: StatusBar) {
        myStatusBar = statusBar
    }
    override fun dispose() {
        hubManager.removeChangeListener(changeListener)
        myStatusBar = null
    }
    override fun getComponent(): JComponent = label
}
