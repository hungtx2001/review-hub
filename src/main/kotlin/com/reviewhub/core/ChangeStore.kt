package com.reviewhub.core

import com.reviewhub.model.*
import com.reviewhub.util.PathUtil
import com.reviewhub.util.ReviewHubPaths
import kotlinx.serialization.Serializable
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
    private val loadedWorkspaces = ConcurrentHashMap.newKeySet<String>()

    fun ensureWorkspaceLoaded(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        if (!loadedWorkspaces.add(normWs)) return
        val dir = getWorkspaceDir(normWs)
        val cpFile = File(dir, "checkpoint.json")
        if (cpFile.exists()) {
            try {
                val cp = json.decodeFromString<CheckpointRecord>(cpFile.readText(Charsets.UTF_8))
                checkpoints[cp.workspace] = cp
            } catch (_: Exception) {}
        }
        val stagingFile = File(dir, "staging.json")
        if (stagingFile.exists()) {
            try {
                val changes = json.decodeFromString<List<ChangeSet>>(stagingFile.readText(Charsets.UTF_8))
                for (cs in changes) {
                    val csNormWs = normalizeWorkspace(cs.workspace)
                    val wsMap = changesByWorkspace.computeIfAbsent(csNormWs) { ConcurrentHashMap() }
                    wsMap[cs.id] = cs
                }
            } catch (_: Exception) {}
        }
    }

    private val listeners = mutableListOf<(workspace: String, path: String) -> Unit>()

    init {
        loadPersistedState()
    }

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
        ensureWorkspaceLoaded(normWs)
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
            ensureWorkspaceLoaded(normWs)
            val found = changesByWorkspace[normWs]?.get(changeId)
            if (found != null) return found
        }

        for (wsMap in changesByWorkspace.values) {
            val found = wsMap[changeId]
            if (found != null) return found
        }
        return null
    }

    fun registerWorkspace(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        if (normWs.isEmpty()) return
        ensureWorkspaceLoaded(normWs)
        changesByWorkspace.computeIfAbsent(normWs) { ConcurrentHashMap() }
    }

    fun findChangeByPath(workspace: String, relPath: String): ChangeSet? {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val normRel = PathUtil.toWorkspaceRelativePath(normWs, relPath)
        val wsChanges = changesByWorkspace[normWs] ?: return null
        return wsChanges.values.firstOrNull { PathUtil.pathsMatch(it.path, normRel) }
    }

    fun propose(
        workspace: String,
        relPath: String,
        content: String,
        proposedExists: Boolean = true
    ): ChangeSet {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val normRel = PathUtil.toWorkspaceRelativePath(normWs, relPath)
        val absFile = File(normWs, normRel)

        val existing = findChangeByPath(normWs, normRel)
        val cp = getOrCreateCheckpoint(normWs)

        // Snapshot initial state before AI modifications for Rollback
        if (!cp.initialSnapshots.containsKey(normRel)) {
            val initialBlob = if (absFile.exists() && !absFile.isDirectory) {
                val diskContent = try { absFile.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
                putBaselineBlob(normWs, diskContent)
            } else {
                "" // file did not exist before AI edits
            }
            cp.initialSnapshots[normRel] = initialBlob
            persistCheckpoint(normWs)
        }

        val baselineExists = existing?.baselineExists
            ?: (cp.files.containsKey(normRel) || (absFile.exists() && !absFile.isDirectory))

        // Baseline resolution: preserve any already-decided hunks from existing staged change
        val baselineContent = if (existing != null && existing.hunks.any { it.decision != "pending" }) {
            val resolvedPartial = HunkDiff.resolve(existing.baseline, existing.hunks)
            val hash = putBaselineBlob(normWs, resolvedPartial)
            cp.files[normRel] = hash
            persistCheckpoint(normWs)
            resolvedPartial
        } else if (cp.files.containsKey(normRel)) {
            readBaselineBlob(normWs, cp.files[normRel]!!)
        } else if (absFile.exists() && !absFile.isDirectory) {
            val diskContent = try { absFile.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
            val hash = putBaselineBlob(normWs, diskContent)
            cp.files[normRel] = hash
            persistCheckpoint(normWs)
            diskContent
        } else {
            ""
        }

        val computedHunks = HunkDiff.computeHunks(baselineContent, content)
        val hunks = if (!proposedExists && computedHunks.isEmpty()) {
            listOf(
                Hunk(
                    id = "hunk-1",
                    oldStart = 0,
                    oldLines = emptyList(),
                    newStart = 0,
                    newLines = emptyList(),
                    decision = "pending"
                )
            )
        } else {
            computedHunks
        }

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
            proposedExists = proposedExists,
            hunks = hunks,
            status = "pending",
            createdAt = existing?.createdAt ?: System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis()
        )

        val wsMap = changesByWorkspace.computeIfAbsent(normWs) { ConcurrentHashMap() }
        wsMap[changeId] = changeSet

        persistStaging(normWs)
        notifyChange(normWs, normRel)
        return changeSet
    }

    fun accept(
        changeId: String? = null,
        workspace: String? = null,
        path: String? = null,
        hunkIds: List<String>? = null,
        customContent: String? = null
    ): DecideResult? {
        if (changeId.isNullOrEmpty() && path.isNullOrEmpty() && !workspace.isNullOrEmpty()) {
            val normWs = normalizeWorkspace(workspace)
            ensureWorkspaceLoaded(normWs)
            val allIds = changesByWorkspace[normWs]?.keys?.toList() ?: emptyList()
            var lastResult: DecideResult? = null
            for (id in allIds) {
                lastResult = accept(changeId = id, workspace = normWs)
            }
            return lastResult ?: DecideResult(changeId = "all", status = "applied", resolved = true, remaining = 0)
        }

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
        val allAccepted = updatedHunks.all { it.decision == "accepted" }
        val isDeletion = !cs.proposedExists && allAccepted

        val resolvedContent = if (customContent != null && allDecided) {
            if (cs.baseline.contains("\r\n") && !customContent.contains("\r\n")) {
                customContent.replace("\n", "\r\n")
            } else {
                customContent
            }
        } else {
            HunkDiff.resolve(cs.baseline, updatedHunks)
        }

        // Write accepted content to disk (or delete file if proposed deletion was accepted)
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        if (allDecided && isDeletion) {
            if (absFile.exists()) {
                try { absFile.delete() } catch (_: Exception) {}
            }
        } else {
            try {
                absFile.parentFile?.mkdirs()
                absFile.writeText(resolvedContent, Charsets.UTF_8)
            } catch (e: Exception) {
                e.printStackTrace()
            }
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
            if (isDeletion) {
                cp.files.remove(cs.path)
            } else {
                cp.files[cs.path] = putBaselineBlob(normWs, resolvedContent)
            }
            persistCheckpoint(normWs)
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        persistStaging(normWs)
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
        if (changeId.isNullOrEmpty() && path.isNullOrEmpty() && !workspace.isNullOrEmpty()) {
            val normWs = normalizeWorkspace(workspace)
            ensureWorkspaceLoaded(normWs)
            val allIds = changesByWorkspace[normWs]?.keys?.toList() ?: emptyList()
            var lastResult: DecideResult? = null
            for (id in allIds) {
                lastResult = reject(changeId = id, workspace = normWs)
            }
            return lastResult ?: DecideResult(changeId = "all", status = "rejected", resolved = true, remaining = 0)
        }

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
        val anyAccepted = updatedHunks.any { it.decision == "accepted" }
        val resolvedContent = HunkDiff.resolve(cs.baseline, updatedHunks)

        // Write resolved (restored baseline) to disk if file was previously modified
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        if (allDecided && !cs.baselineExists && !anyAccepted) {
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
            if (anyAccepted) {
                val cp = getOrCreateCheckpoint(normWs)
                cp.files[cs.path] = putBaselineBlob(normWs, resolvedContent)
                persistCheckpoint(normWs)
            }
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        persistStaging(normWs)
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
        ensureWorkspaceLoaded(normWs)
        val normRel = PathUtil.toWorkspaceRelativePath(normWs, relPath)

        val active = findChangeByPath(normWs, normRel)
        if (active != null) {
            if (!active.proposedExists && active.hunks.none { it.decision == "rejected" }) {
                return ""
            }
            return HunkDiff.resolveStaged(active.baseline, active.hunks)
        }

        val file = File(normWs, normRel)
        return if (file.exists() && !file.isDirectory) {
            try { file.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
        } else {
            ""
        }
    }

    fun setCheckpoint(workspace: String): CheckpointInfo {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
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
            files = fileMap,
            initialSnapshots = HashMap(fileMap)
        )
        checkpoints[normWs] = record

        // A fresh checkpoint clears existing pending changes
        changesByWorkspace[normWs]?.clear()

        persistCheckpoint(normWs)
        persistStaging(normWs)
        notifyChange(normWs, "")

        return CheckpointInfo(normWs, record.setAt)
    }

    fun rollbackToCheckpoint(workspace: String): List<String> {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val cp = checkpoints[normWs] ?: return emptyList()
        val restoredFiles = mutableListOf<String>()

        for ((relPath, initialHash) in cp.initialSnapshots) {
            val targetFile = File(normWs, relPath)
            if (initialHash.isEmpty()) {
                if (targetFile.exists()) {
                    try {
                        targetFile.delete()
                        restoredFiles.add(relPath)
                    } catch (_: Exception) {}
                }
            } else {
                val baselineContent = readBaselineBlob(normWs, initialHash)
                try {
                    targetFile.parentFile?.mkdirs()
                    targetFile.writeText(baselineContent, Charsets.UTF_8)
                    restoredFiles.add(relPath)
                } catch (_: Exception) {}
            }
        }

        changesByWorkspace[normWs]?.clear()
        cp.files.clear()
        cp.files.putAll(cp.initialSnapshots.filterValues { it.isNotEmpty() })

        persistCheckpoint(normWs)
        persistStaging(normWs)
        notifyChange(normWs, "")
        return restoredFiles
    }

    fun getReviewStatus(workspace: String, path: String? = null, changeId: String? = null): ReviewStatusResult {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val cs = resolveTargetChangeSet(changeId, normWs, path)
        if (cs == null) {
            val wsChanges = changesByWorkspace[normWs]?.values?.toList() ?: emptyList()
            if (wsChanges.isEmpty()) {
                return ReviewStatusResult(
                    workspace = normWs,
                    status = "idle",
                    totalHunks = 0,
                    pendingHunks = 0,
                    acceptedHunks = 0,
                    rejectedHunks = 0
                )
            }
            val totalPending = wsChanges.sumOf { it.hunks.count { h -> h.decision == "pending" } }
            return ReviewStatusResult(
                workspace = normWs,
                status = if (totalPending > 0) "pending" else "applied",
                totalHunks = wsChanges.sumOf { it.hunks.size },
                pendingHunks = totalPending,
                acceptedHunks = wsChanges.sumOf { it.hunks.count { h -> h.decision == "accepted" } },
                rejectedHunks = wsChanges.sumOf { it.hunks.count { h -> h.decision == "rejected" } }
            )
        }

        val pending = cs.hunks.count { it.decision == "pending" }
        val accepted = cs.hunks.count { it.decision == "accepted" }
        val rejected = cs.hunks.count { it.decision == "rejected" }
        return ReviewStatusResult(
            workspace = normWs,
            path = cs.path,
            changeId = cs.id,
            status = cs.status,
            totalHunks = cs.hunks.size,
            pendingHunks = pending,
            acceptedHunks = accepted,
            rejectedHunks = rejected
        )
    }

    fun clearCheckpoint(workspace: String): Boolean {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        checkpoints.remove(normWs)
        changesByWorkspace[normWs]?.clear()

        persistCheckpoint(normWs)
        persistStaging(normWs)
        notifyChange(normWs, "")
        return true
    }

    fun checkpointInfo(workspace: String): CheckpointInfo? {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
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
        ensureWorkspaceLoaded(workspace)
        return checkpoints.computeIfAbsent(workspace) {
            CheckpointRecord(workspace, System.currentTimeMillis(), mutableMapOf())
        }
    }

    private fun getWorkspaceDir(workspace: String): File {
        return ReviewHubPaths.getWorkspaceDir(workspace, sha256(workspace).take(16))
    }

    private fun getBaselinesDir(workspace: String): File {
        val dir = File(getWorkspaceDir(workspace), "baselines")
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

    private fun persistStaging(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        val dir = getWorkspaceDir(normWs)
        val stagingFile = File(dir, "staging.json")
        val wsChanges = changesByWorkspace[normWs]?.values?.toList() ?: emptyList()

        if (wsChanges.isEmpty()) {
            if (stagingFile.exists()) {
                try { stagingFile.delete() } catch (_: Exception) {}
            }
        } else {
            try {
                dir.mkdirs()
                stagingFile.writeText(json.encodeToString(wsChanges), Charsets.UTF_8)
            } catch (_: Exception) {}
        }
    }

    private fun persistCheckpoint(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        val dir = getWorkspaceDir(normWs)
        val cpFile = File(dir, "checkpoint.json")
        val cp = checkpoints[normWs]

        if (cp == null) {
            if (cpFile.exists()) {
                try { cpFile.delete() } catch (_: Exception) {}
            }
        } else {
            try {
                dir.mkdirs()
                cpFile.writeText(json.encodeToString(cp), Charsets.UTF_8)
            } catch (_: Exception) {}
        }
    }

    private fun loadPersistedState() {
        val tmpDir = System.getProperty("java.io.tmpdir") ?: "."
        val root = Paths.get(tmpDir, "review-hub", "workspaces").toFile()
        if (!root.exists() || !root.isDirectory) return

        val wsFolders = root.listFiles() ?: return
        for (folder in wsFolders) {
            if (!folder.isDirectory) continue

            // 1. Load checkpoint
            val cpFile = File(folder, "checkpoint.json")
            if (cpFile.exists()) {
                try {
                    val cp = json.decodeFromString<CheckpointRecord>(cpFile.readText(Charsets.UTF_8))
                    checkpoints[cp.workspace] = cp
                } catch (_: Exception) {}
            }

            // 2. Load staging changes
            val stagingFile = File(folder, "staging.json")
            if (stagingFile.exists()) {
                try {
                    val changes = json.decodeFromString<List<ChangeSet>>(stagingFile.readText(Charsets.UTF_8))
                    for (cs in changes) {
                        val normWs = normalizeWorkspace(cs.workspace)
                        val wsMap = changesByWorkspace.computeIfAbsent(normWs) { ConcurrentHashMap() }
                        wsMap[cs.id] = cs
                    }
                } catch (_: Exception) {}
            }
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

@Serializable
data class CheckpointRecord(
    val workspace: String,
    val setAt: Long,
    val files: MutableMap<String, String> = mutableMapOf(),
    val initialSnapshots: MutableMap<String, String> = mutableMapOf()
)
