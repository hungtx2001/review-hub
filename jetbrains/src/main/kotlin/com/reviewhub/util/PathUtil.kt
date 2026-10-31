package com.reviewhub.util

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

object PathUtil {
    fun toRelativePath(project: Project, file: VirtualFile): String? {
        val basePath = project.basePath ?: return null
        return toRelativePath(basePath, file.path)
    }

    fun toRelativePath(basePath: String, filePath: String): String? {
        val normBase = basePath.replace('\\', '/').trimEnd('/')
        val normFile = filePath.replace('\\', '/')
        if (!normFile.startsWith(normBase, ignoreCase = true)) {
            return null
        }
        return normFile.substring(normBase.length).trimStart('/')
    }

    fun pathsMatch(pathA: String?, pathB: String?): Boolean {
        if (pathA == null || pathB == null) return false
        val normA = pathA.replace('\\', '/').trim('/')
        val normB = pathB.replace('\\', '/').trim('/')
        return normA.equals(normB, ignoreCase = true)
    }

    fun normalizeWorkspaceCandidates(workspace: String): List<String> {
        val norm = workspace.replace('\\', '/').trimEnd('/')
        val variants = mutableListOf<String>()

        variants.add(norm)
        if (norm.length >= 2 && norm[1] == ':') {
            val upperDrive = norm.substring(0, 1).uppercase() + norm.substring(1)
            val lowerDrive = norm.substring(0, 1).lowercase() + norm.substring(1)
            variants.add(upperDrive)
            variants.add(lowerDrive)
        }

        return variants.flatMap { ws ->
            listOf(ws, ws.replace('/', '\\'))
        }.distinct()
    }
}
