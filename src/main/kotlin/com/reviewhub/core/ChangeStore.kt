package com.reviewhub.core

import com.reviewhub.model.*
import com.reviewhub.util.PathUtil
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Paths
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

class ChangeStore {

    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true; isLenient = true }

    // workspacePath -> (changeId -> ChangeSet)
    private val changesByWorkspace = ConcurrentHashMap<String, ConcurrentHashMap<String, ChangeSet>>()

    // workspacePath -> CheckpointRecord
    private val checkpoints = ConcurrentHashMap<String, CheckpointRecord>()

    private val listeners = mutableListOf<(workspace: String, path: String) -> Unit>()

    fun addChangeListener(listener: (workspace: String, path: String) -> Unit) {
        listeners.add(listener)
    }

    private fun notifyChange(workspace: String, path: String) {
        for (l in listeners) {
            try {
                l(workspace, path)
            } catch (_: Exception) {}
        }
    }

    fun listWorkspaces(): List<String> {
        val list = mutableSetOf<String>()
        list.addAll(changesByWorkspace.keys)
        list.addAll(checkpoints.keys)
        return list.toList()
    }

    fun listChanges(workspace: String): List<ChangeSummary> {
        val normWs = normalizeWorkspace(workspace)
        val wsChanges = changesByWorkspace[normWs] ?: return emptyList()

        return wsChanges.values.map { cs ->
            val added = cs.hunks.sumOf { it.newLines.size }
            val removed = cs.hunks.sumOf { it.oldLines.size }
            val accepted = cs.hunks.count { it.decision == "accepted" }
            val rejected = cs.hunks.count { it.decision == "rejected" }
            val pending = cs.hunks.count { it.decision == "pending" }

            ChangeSummary(
                id = cs.id,
                workspace = cs.workspace,
                path = cs.path,
                origin = cs.origin,
                applied = cs.applied,
                status = cs.status,
                binary = cs.binary,
                added = added,
                removed = removed,
                accepted = accepted,
                rejected = rejected,
                pending = pending
            )
        }
    }

    fun getChange(changeId: String, workspace: String? = null): ChangeSet? {
        if (workspace != null) {
            val normWs = normalizeWorkspace(workspace)
            val found = changesByWorkspace[normWs]?.get(changeId)
            if (found != null) return found
        }

        for (wsMap in changesByWorkspace.values) {
            val found = wsMap[changeId]
            if (found != null) return found
        }
        return null
    }

    fun findChangeByPath(workspace: String, relPath: String): ChangeSet? {
        val normWs = normalizeWorkspace(workspace)
        val normRel = PathUtil.toRelativePathString(relPath)
        val wsChanges = changesByWorkspace[normWs] ?: return null
        return wsChanges.values.firstOrNull { PathUtil.pathsMatch(it.path, normRel) }
    }

    fun propose(workspace: String, relPath: String, content: String): ChangeSet {
        val normWs = normalizeWorkspace(workspace)
        val normRel = PathUtil.toRelativePathString(relPath)
        val absFile = File(normWs, normRel)

        // Baseline resolution
        val cp = getOrCreateCheckpoint(normWs)
        val baselineContent = if (cp.files.containsKey(normRel)) {
            readBaselineBlob(normWs, cp.files[normRel]!!)
        } else if (absFile.exists() && !absFile.isDirectory) {
            val diskContent = try { absFile.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
            val hash = putBaselineBlob(normWs, diskContent)
            cp.files[normRel] = hash
            diskContent
        } else {
            ""
        }

        val baselineExists = absFile.exists()
        val hunks = HunkDiff.computeHunks(baselineContent, content)

        val existing = findChangeByPath(normWs, normRel)
        val changeId = existing?.id ?: "cs-" + sha256("$normWs:$normRel").take(12)

        val changeSet = ChangeSet(
            id = changeId,
            workspace = normWs,
            path = normRel,
            absPath = absFile.absolutePath,
            origin = "mcp",
            applied = false,
            binary = false,
            baseline = baselineContent,
            proposed = content,
            baselineExists = baselineExists,
            proposedExists = true,
            hunks = hunks,
            status = "pending",
            createdAt = existing?.createdAt ?: System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis()
        )

        val wsMap = changesByWorkspace.computeIfAbsent(normWs) { ConcurrentHashMap() }
        wsMap[changeId] = changeSet

        notifyChange(normWs, normRel)
        return changeSet
    }

    fun accept(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        val cs = resolveTargetChangeSet(changeId, workspace, path) ?: return null
        val normWs = cs.workspace

        val updatedHunks = cs.hunks.map { hunk ->
            if (hunkIds == null || hunk.id in hunkIds) {
                hunk.copy(decision = "accepted")
            } else {
                hunk
            }
        }

        val allDecided = updatedHunks.none { it.decision == "pending" }
        val resolvedContent = HunkDiff.resolve(cs.baseline, updatedHunks)

        // Write accepted content to disk
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        try {
            absFile.parentFile?.mkdirs()
            absFile.writeText(resolvedContent, Charsets.UTF_8)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        val newStatus = if (allDecided) "applied" else "pending"
        val updatedCs = cs.copy(
            hunks = updatedHunks,
            status = newStatus,
            applied = true,
            updatedAt = System.currentTimeMillis()
        )

        val wsMap = changesByWorkspace[normWs]
        if (allDecided) {
            wsMap?.remove(cs.id)
            // Advance baseline in checkpoint
            val cp = getOrCreateCheckpoint(normWs)
            cp.files[cs.path] = putBaselineBlob(normWs, resolvedContent)
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        notifyChange(normWs, cs.path)

        val remaining = updatedHunks.count { it.decision == "pending" }
        return DecideResult(
            changeId = cs.id,
            status = newStatus,
            resolved = allDecided,
            remaining = remaining,
            hunks = updatedHunks
        )
    }

    fun reject(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        val cs = resolveTargetChangeSet(changeId, workspace, path) ?: return null
        val normWs = cs.workspace

        val updatedHunks = cs.hunks.map { hunk ->
            if (hunkIds == null || hunk.id in hunkIds) {
                hunk.copy(decision = "rejected")
            } else {
                hunk
            }
        }

        val allDecided = updatedHunks.none { it.decision == "pending" }
        val resolvedContent = HunkDiff.resolve(cs.baseline, updatedHunks)

        // Write resolved (restored baseline) to disk if file was previously modified
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        if (allDecided && !cs.baselineExists) {
            if (absFile.exists()) absFile.delete()
        } else {
            try {
                absFile.parentFile?.mkdirs()
                absFile.writeText(resolvedContent, Charsets.UTF_8)
            } catch (_: Exception) {}
        }

        val newStatus = if (allDecided) "rejected" else "pending"
        val updatedCs = cs.copy(
            hunks = updatedHunks,
            status = newStatus,
            updatedAt = System.currentTimeMillis()
        )

        val wsMap = changesByWorkspace[normWs]
        if (allDecided) {
            wsMap?.remove(cs.id)
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        notifyChange(normWs, cs.path)

        val remaining = updatedHunks.count { it.decision == "pending" }
        return DecideResult(
            changeId = cs.id,
            status = newStatus,
            resolved = allDecided,
            remaining = remaining,
            hunks = updatedHunks
        )
    }

    fun readFile(workspace: String, relPath: String): String {
        val normWs = normalizeWorkspace(workspace)
        val normRel = PathUtil.toRelativePathString(relPath)

        val active = findChangeByPath(normWs, normRel)
        if (active != null) {
            return HunkDiff.resolveStaged(active.baseline, active.hunks)
        }

        val file = File(normWs, normRel)
        return if (file.exists()) {
            try { file.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
        } else {
            ""
        }
    }

    fun setCheckpoint(workspace: String): CheckpointInfo {
        val normWs = normalizeWorkspace(workspace)
        val wsDir = File(normWs)
        val fileMap = mutableMapOf<String, String>()

        if (wsDir.exists() && wsDir.isDirectory) {
            val ignoredDirs = setOf(".git", ".gradle", ".idea", "node_modules", "build", "dist", ".kotlin", "target")

            fun scanDir(dir: File) {
                val files = dir.listFiles() ?: return
                for (f in files) {
                    if (f.isDirectory) {
                        if (f.name !in ignoredDirs) {
                            scanDir(f)
                        }
                    } else if (f.isFile) {
                        if (f.length() < 2 * 1024 * 1024) { // Max 2MB per text file
                            val rel = f.relativeTo(wsDir).path.replace('\\', '/')
                            try {
                                val content = f.readText(Charsets.UTF_8)
                                val hash = putBaselineBlob(normWs, content)
                                fileMap[rel] = hash
                            } catch (_: Exception) {}
                        }
                    }
                }
            }

            scanDir(wsDir)
        }

        val record = CheckpointRecord(
            workspace = normWs,
            setAt = System.currentTimeMillis(),
            files = fileMap
        )
        checkpoints[normWs] = record

        // A fresh checkpoint clears existing pending changes
        changesByWorkspace[normWs]?.clear()
        notifyChange(normWs, "")

        return CheckpointInfo(normWs, record.setAt)
    }

    fun clearCheckpoint(workspace: String): Boolean {
        val normWs = normalizeWorkspace(workspace)
        checkpoints.remove(normWs)
        changesByWorkspace[normWs]?.clear()
        notifyChange(normWs, "")
        return true
    }

    fun checkpointInfo(workspace: String): CheckpointInfo? {
        val normWs = normalizeWorkspace(workspace)
        val cp = checkpoints[normWs] ?: return null
        return CheckpointInfo(normWs, cp.setAt)
    }

    private fun resolveTargetChangeSet(changeId: String?, workspace: String?, path: String?): ChangeSet? {
        if (changeId != null) {
            val found = getChange(changeId, workspace)
            if (found != null) return found
        }
        if (workspace != null && path != null) {
            val found = findChangeByPath(workspace, path)
            if (found != null) return found
        }
        return null
    }

    private fun getOrCreateCheckpoint(workspace: String): CheckpointRecord {
        return checkpoints.computeIfAbsent(workspace) {
            CheckpointRecord(workspace, System.currentTimeMillis(), mutableMapOf())
        }
    }

    private fun getBaselinesDir(workspace: String): File {
        val home = System.getProperty("user.home") ?: "."
        val wsHash = sha256(workspace).take(16)
        val dir = Paths.get(home, ".review-hub", "workspaces", wsHash, "baselines").toFile()
        dir.mkdirs()
        return dir
    }

    private fun putBaselineBlob(workspace: String, content: String): String {
        val hash = sha256(content)
        val file = File(getBaselinesDir(workspace), hash)
        if (!file.exists()) {
            try { file.writeText(content, Charsets.UTF_8) } catch (_: Exception) {}
        }
        return hash
    }

    private fun readBaselineBlob(workspace: String, hash: String): String {
        val file = File(getBaselinesDir(workspace), hash)
        return if (file.exists()) {
            try { file.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
        } else {
            ""
        }
    }

    private fun normalizeWorkspace(path: String): String {
        return PathUtil.normalizeWorkspace(path).replace('\\', '/')
    }

    private fun sha256(input: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}

data class CheckpointRecord(
    val workspace: String,
    val setAt: Long,
    val files: MutableMap<String, String> = mutableMapOf()
)