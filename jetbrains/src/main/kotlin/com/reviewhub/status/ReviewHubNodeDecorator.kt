package com.reviewhub.status

import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.ProjectViewNodeDecorator
import com.intellij.ui.SimpleTextAttributes
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil

class ReviewHubNodeDecorator : ProjectViewNodeDecorator {
    override fun decorate(node: ProjectViewNode<*>, data: PresentationData) {
        val project = node.project ?: return
        val virtualFile = node.virtualFile ?: return
        val relPath = PathUtil.toRelativePath(project, virtualFile) ?: return

        val hubManager = project.getService(HubManager::class.java)
        val change = hubManager.changes.find {
            PathUtil.pathsMatch(it.path, relPath) && it.status == "pending"
        } ?: return

        data.addText(" [${change.pending}]", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
    }
}
