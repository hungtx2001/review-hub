package com.reviewhub.util

import java.io.File
import java.nio.file.Paths

object ReviewHubPaths {

    /**
     * Runtime hub discovery file (`hub.json`).
     * Stored in the OS temp directory so multiple IDE windows (backend & frontend)
     * can discover the primary server without cluttering the user's home directory.
     * Cleaned up automatically on OS reboot.
     */
    fun getHubJsonFile(): File {
        val tmpDir = System.getProperty("java.io.tmpdir") ?: "."
        return Paths.get(tmpDir, "review-hub", "hub.json").toFile()
    }

    /**
     * Staging & baselines directory for a specific workspace.
     * Prefers `<workspace>/.idea/review-hub` if the workspace folder exists,
     * ensuring each project (backend, frontend) manages its own isolated diffs.
     * Falls back to a temp subfolder if the workspace is not a valid directory.
     */
    fun getWorkspaceDir(workspace: String, wsHash: String): File {
        val wsFile = File(workspace)
        val dir = if (wsFile.exists() && wsFile.isDirectory) {
            File(wsFile, ".idea/review-hub")
        } else {
            val tmpDir = System.getProperty("java.io.tmpdir") ?: "."
            Paths.get(tmpDir, "review-hub", "workspaces", wsHash).toFile()
        }
        dir.mkdirs()
        return dir
    }
}

