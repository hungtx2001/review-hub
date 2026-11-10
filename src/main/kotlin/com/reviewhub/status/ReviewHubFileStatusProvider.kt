package com.reviewhub.status

import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatus
import com.intellij.openapi.vcs.impl.FileStatusProvider
import com.intellij.openapi.vfs.VirtualFile
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil

class ReviewHubFileStatusProvider(private val project: Project) : FileStatusProvider {
    override fun getFileStatus(virtualFile: VirtualFile): FileStatus? {
        val hubManager = project.getService(HubManager::class.java)
        if (!hubManager.hasPendingChanges) return null
        val relPath = PathUtil.toRelativePath(project, virtualFile) ?: return null
        val change = hubManager.findChange(relPath) ?: return null

        return when {
            !change.proposedExists -> FileStatus.DELETED
            !change.baselineExists -> FileStatus.ADDED
            else -> FileStatus.MODIFIED
        }
    }
}
