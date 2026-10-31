package com.reviewhub.status

import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatus
import com.intellij.openapi.vcs.impl.FileStatusProvider
import com.intellij.openapi.vfs.VirtualFile
import com.reviewhub.hub.HubManager
import com.reviewhub.util.PathUtil

class ReviewHubFileStatusProvider(private val project: Project) : FileStatusProvider {
    override fun getFileStatus(virtualFile: VirtualFile): FileStatus? {
        val relPath = PathUtil.toRelativePath(project, virtualFile) ?: return null
        val hubManager = project.getService(HubManager::class.java)
        val change = hubManager.changes.find {
            PathUtil.pathsMatch(it.path, relPath) && it.status == "pending"
        } ?: return null

        return if (change.applied) FileStatus.MODIFIED else FileStatus.ADDED
    }
}
