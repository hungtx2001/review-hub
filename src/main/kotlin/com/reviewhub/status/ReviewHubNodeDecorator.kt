package com.reviewhub.status

import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.ProjectViewNodeDecorator
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil
import java.awt.Color

class ReviewHubNodeDecorator : ProjectViewNodeDecorator {
    companion object {
        private val PENDING_ATTR = SimpleTextAttributes(
            SimpleTextAttributes.STYLE_BOLD,
            JBColor(Color(0x1A, 0x7F, 0x37), Color(0x3F, 0xB9, 0x50))
        )
    }

    override fun decorate(node: ProjectViewNode<*>, data: PresentationData) {
        val project = node.project ?: return
        val virtualFile = node.virtualFile ?: return
        val relPath = PathUtil.toRelativePath(project, virtualFile) ?: return

        val hubManager = project.getService(HubManager::class.java)
        val change = hubManager.changes.find {
            PathUtil.pathsMatch(it.path, relPath) && it.status != "resolved"
        } ?: return

        if (change.pending > 0) {
            val stats = if (change.added > 0 || change.removed > 0) {
                " [${change.pending} pending: +${change.added} -${change.removed}]"
            } else {
                " [${change.pending} pending]"
            }
            data.addText(stats, PENDING_ATTR)
        }
    }
}
