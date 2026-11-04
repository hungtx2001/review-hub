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

    fun normalizeWorkspace(workspace: String): String {
        val norm = workspace.replace('\\', '/').trimEnd('/')
        if (norm.length >= 2 && norm[1] == ':' && norm[0].isLetter()) {
            return norm[0].uppercaseChar() + norm.substring(1)
        }
        return norm
    }

    fun toRelativePathString(path: String): String {
        return path.replace('\\', '/').trimStart('/')
    }

    fun toWorkspaceRelativePath(workspace: String, path: String): String {
        val normWs = normalizeWorkspace(workspace)
        if (normWs.isNotEmpty()) {
            val rel = toRelativePath(normWs, path)
            if (rel != null) return rel
        }
        return toRelativePathString(path)
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
