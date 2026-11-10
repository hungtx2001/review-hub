package com.reviewhub.core

import com.reviewhub.model.*
import com.reviewhub.util.PathUtil
import com.reviewhub.util.ReviewHubPaths
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.security.MessageDigest
import java.util.HexFormat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class ChangeStore {

    private val json = Json { prettyPrint = false; ignoreUnknownKeys = true; isLenient = true }

    // workspacePath -> (changeId -> ChangeSet)
    private val changesByWorkspace = ConcurrentHashMap<String, ConcurrentHashMap<String, ChangeSet>>()

    // workspacePath -> CheckpointRecord
    private val checkpoints = ConcurrentHashMap<String, CheckpointRecord>()
    private val loadedWorkspaces = ConcurrentHashMap.newKeySet<String>()

    private val listeners = CopyOnWriteArrayList<(workspace: String, path: String) -> Unit>()

    init {
        loadPersistedState()
    }

    fun ensureWorkspaceLoaded(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        if (normWs.isEmpty() || !loadedWorkspaces.add(normWs)) return
        val dir = getWorkspaceDir(normWs)
        val cpFile = File(dir, "checkpoint.json")
        if (cpFile.exists()) {
            try {
                val cp = json.decodeFromString<CheckpointRecord>(cpFile.readText(Charsets.UTF_8))
                checkpoints[normWs] = cp.copy(workspace = normWs)
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

        return wsChanges.values
            .sortedBy { it.path }
            .map { cs ->
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
                    baselineExists = cs.baselineExists,
                    proposedExists = cs.proposedExists,
                    added = added,
                    removed = removed,
                    accepted = accepted,
                    rejected = rejected,
                    pending = pending,
                    updatedAt = cs.updatedAt
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

    /**
     * Stages a proposed file edit/write/deletion AND immediately syncs the staged state to disk
     * (Shadow Baseline + Live Disk Sync).
     *
     * - Original file state is safely snapshotted in CAS baseline blobs (`cp.initialSnapshots` & `baseline`)
     *   BEFORE writing the proposed content to disk.
     * - Compilers, build tools, and test runners invoked by AI agents immediately see the proposed code on disk.
     * - Rejecting a hunk/file or rolling back to checkpoint immediately restores the snapshotted baseline to disk.
     */
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

        // 1. Lazy Copy-on-Write Snapshot of initial state BEFORE AI modifies disk
        if (!cp.initialSnapshots.containsKey(normRel)) {
            val initialBlob = when {
                existing != null -> {
                    if (existing.baselineExists) putBaselineBlob(normWs, existing.baseline) else ""
                }
                absFile.exists() && !absFile.isDirectory -> {
                    val diskContent = try { absFile.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
                    putBaselineBlob(normWs, diskContent)
                }
                else -> "" // File did not exist before AI edits
            }
            cp.initialSnapshots[normRel] = initialBlob
            if (initialBlob.isNotEmpty() && !cp.files.containsKey(normRel)) {
                cp.files[normRel] = initialBlob
            }
            persistCheckpoint(normWs)
        }

        val baselineExists = existing?.baselineExists
            ?: (cp.files.containsKey(normRel) || (absFile.exists() && !absFile.isDirectory))

        // 2. Baseline resolution: preserve any already-decided hunks from existing staged change
        val baselineContent = if (existing != null) {
            if (existing.hunks.any { it.decision != "pending" }) {
                val resolvedPartial = HunkDiff.resolve(existing.baseline, existing.hunks)
                val hash = putBaselineBlob(normWs, resolvedPartial)
                cp.files[normRel] = hash
                persistCheckpoint(normWs)
                resolvedPartial
            } else {
                existing.baseline
            }
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
        val changeId = existing?.id ?: "cs-" + sha256("$normWs:$normRel").take(12)

        // 3. Auto-clear if AI reverted the file back to match the baseline
        if (existing != null && computedHunks.isEmpty() && baselineExists == proposedExists) {
            if (!proposedExists) {
                deleteFileOnDisk(absFile, File(normWs))
            } else {
                writeFileOnDisk(absFile, baselineContent)
            }
            changesByWorkspace[normWs]?.remove(changeId)
            persistStaging(normWs)
            notifyChange(normWs, normRel)
            return existing.copy(
                proposed = content,
                proposedExists = proposedExists,
                hunks = emptyList(),
                status = "applied",
                applied = true,
                updatedAt = System.currentTimeMillis()
            )
        }

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
        } else if (proposedExists && !baselineExists && computedHunks.isEmpty()) {
            // Brand new empty file
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

        // 4. Live Disk Sync: write proposed content to disk immediately so build/test tools see it
        if (!proposedExists) {
            deleteFileOnDisk(absFile, File(normWs))
        } else {
            val sep = if (content.contains("\r\n")) "\r\n" else "\n"
            val stagedDiskText = HunkDiff.resolveStaged(baselineContent, hunks, sep)
            writeFileOnDisk(absFile, stagedDiskText)
        }

        val changeSet = ChangeSet(
            id = changeId,
            workspace = normWs,
            path = normRel,
            absPath = absFile.absolutePath,
            origin = "mcp",
            applied = true, // Live-synced to disk for compiler/test execution
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
            if (allIds.isEmpty()) {
                return DecideResult(changeId = "all", status = "applied", resolved = true, remaining = 0)
            }
            var lastResult: DecideResult? = null
            for (id in allIds) {
                lastResult = acceptInternal(changeId = id, workspace = normWs, batchMode = true)
            }
            persistCheckpoint(normWs)
            persistStaging(normWs)
            pruneUnusedBlobs(normWs)
            notifyChange(normWs, "")
            return lastResult ?: DecideResult(changeId = "all", status = "applied", resolved = true, remaining = 0)
        }
        return acceptInternal(changeId, workspace, path, hunkIds, customContent, batchMode = false)
    }

    private fun acceptInternal(
        changeId: String? = null,
        workspace: String? = null,
        path: String? = null,
        hunkIds: List<String>? = null,
        customContent: String? = null,
        batchMode: Boolean = false
    ): DecideResult? {
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

        val propSep = if (cs.proposed.contains("\r\n")) "\r\n" else "\n"
        val resolvedContent = if (customContent != null && allDecided) {
            if ((cs.baseline.contains("\r\n") || cs.proposed.contains("\r\n")) && !customContent.contains("\r\n")) {
                customContent.replace("\n", "\r\n")
            } else {
                customContent
            }
        } else if (allDecided) {
            HunkDiff.resolve(cs.baseline, updatedHunks, propSep)
        } else {
            HunkDiff.resolveStaged(cs.baseline, updatedHunks, propSep)
        }

        // Write accepted/staged content to disk (or delete file if proposed deletion was accepted)
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        if (!cs.proposedExists) {
            if (allDecided && allAccepted) {
                deleteFileOnDisk(absFile, File(normWs))
            }
        } else {
            writeFileOnDisk(absFile, resolvedContent)
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
            if (!batchMode) {
                persistCheckpoint(normWs)
                pruneUnusedBlobs(normWs)
            }
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        if (!batchMode) {
            persistStaging(normWs)
            notifyChange(normWs, cs.path)
        }

        val remaining = updatedHunks.count { it.decision == "pending" }
        return DecideResult(
            changeId = cs.id,
            status = newStatus,
            resolved = allDecided,
            remaining = remaining,
            hunks = updatedHunks
        )
    }

    fun reject(
        changeId: String? = null,
        workspace: String? = null,
        path: String? = null,
        hunkIds: List<String>? = null
    ): DecideResult? {
        if (changeId.isNullOrEmpty() && path.isNullOrEmpty() && !workspace.isNullOrEmpty()) {
            val normWs = normalizeWorkspace(workspace)
            ensureWorkspaceLoaded(normWs)
            val allIds = changesByWorkspace[normWs]?.keys?.toList() ?: emptyList()
            if (allIds.isEmpty()) {
                return DecideResult(changeId = "all", status = "rejected", resolved = true, remaining = 0)
            }
            var lastResult: DecideResult? = null
            for (id in allIds) {
                lastResult = rejectInternal(changeId = id, workspace = normWs, batchMode = true)
            }
            persistCheckpoint(normWs)
            persistStaging(normWs)
            pruneUnusedBlobs(normWs)
            notifyChange(normWs, "")
            return lastResult ?: DecideResult(changeId = "all", status = "rejected", resolved = true, remaining = 0)
        }
        return rejectInternal(changeId, workspace, path, hunkIds, batchMode = false)
    }

    private fun rejectInternal(
        changeId: String? = null,
        workspace: String? = null,
        path: String? = null,
        hunkIds: List<String>? = null,
        batchMode: Boolean = false
    ): DecideResult? {
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

        // If all hunks decided, resolve final content; otherwise resolve remaining staged content
        val propSep = if (cs.proposed.contains("\r\n")) "\r\n" else "\n"
        val targetDiskContent = if (allDecided) {
            HunkDiff.resolve(cs.baseline, updatedHunks, propSep)
        } else {
            HunkDiff.resolveStaged(cs.baseline, updatedHunks, propSep)
        }

        // Write restored baseline (or partially rejected state) back to disk immediately
        val absFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
        if (allDecided && !cs.baselineExists && !anyAccepted) {
            deleteFileOnDisk(absFile, File(normWs))
        } else if (!cs.proposedExists && !allDecided) {
            // Still pending deletion
        } else {
            writeFileOnDisk(absFile, targetDiskContent)
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
                cp.files[cs.path] = putBaselineBlob(normWs, targetDiskContent)
                if (!batchMode) {
                    persistCheckpoint(normWs)
                }
            }
            if (!batchMode) {
                pruneUnusedBlobs(normWs)
            }
        } else {
            wsMap?.put(cs.id, updatedCs)
        }

        if (!batchMode) {
            persistStaging(normWs)
            notifyChange(normWs, cs.path)
        }

        val remaining = updatedHunks.count { it.decision == "pending" }
        return DecideResult(
            changeId = cs.id,
            status = newStatus,
            resolved = allDecided,
            remaining = remaining,
            hunks = updatedHunks
        )
    }

    fun readFile(workspace: String, relPath: String, startLine: Int? = null, endLine: Int? = null): String {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val normRel = PathUtil.toWorkspaceRelativePath(normWs, relPath)

        val fullText = findChangeByPath(normWs, normRel)?.let { active ->
            if (!active.proposedExists && active.hunks.none { it.decision == "rejected" }) {
                ""
            } else {
                HunkDiff.resolveStaged(active.baseline, active.hunks)
            }
        } ?: run {
            val file = File(normWs, normRel)
            if (file.exists() && !file.isDirectory) {
                try { file.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
            } else {
                ""
            }
        }

        if (startLine == null && endLine == null) return fullText
        if (fullText.isEmpty()) return ""
        val lines = fullText.lines()
        val from = ((startLine ?: 1) - 1).coerceIn(0, lines.size)
        val to = (endLine ?: lines.size).coerceIn(from, lines.size)
        return lines.subList(from, to).joinToString("\n")
    }

    /**
     * Lazy Copy-on-Write Checkpoint:
     * Marks the current workspace state as the clean baseline in < 1ms without scanning
     * thousands of untouched files upfront. Files are snapshotted automatically on demand
     * inside `propose()` right before any AI modification touches them.
     */
    fun setCheckpoint(workspace: String): CheckpointInfo {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)

        val record = CheckpointRecord(
            workspace = normWs,
            setAt = System.currentTimeMillis(),
            files = mutableMapOf(),
            initialSnapshots = mutableMapOf()
        )
        checkpoints[normWs] = record

        // Accepting current disk state as baseline clears existing pending changes
        changesByWorkspace[normWs]?.clear()

        persistCheckpoint(normWs)
        persistStaging(normWs)
        pruneUnusedBlobs(normWs)
        notifyChange(normWs, "")

        return CheckpointInfo(normWs, record.setAt)
    }

    fun rollbackToCheckpoint(workspace: String): List<String> {
        val normWs = normalizeWorkspace(workspace)
        ensureWorkspaceLoaded(normWs)
        val cp = checkpoints[normWs]
        val activeChanges = changesByWorkspace[normWs]?.values?.toList() ?: emptyList()

        if (cp == null && activeChanges.isEmpty()) return emptyList()

        val restoredFiles = mutableSetOf<String>()
        val wsRoot = File(normWs)

        // 1. Restore from initialSnapshots if checkpoint exists
        if (cp != null) {
            for ((relPath, initialHash) in cp.initialSnapshots) {
                val targetFile = File(normWs, relPath)
                if (initialHash.isEmpty()) {
                    if (targetFile.exists()) {
                        deleteFileOnDisk(targetFile, wsRoot)
                        restoredFiles.add(relPath)
                    }
                } else {
                    val baselineContent = readBaselineBlob(normWs, initialHash)
                    writeFileOnDisk(targetFile, baselineContent)
                    restoredFiles.add(relPath)
                }
            }
        }

        // 2. Also ensure any active pending changes not in initialSnapshots are reverted
        for (cs in activeChanges) {
            if (cs.path !in restoredFiles) {
                val targetFile = File(cs.absPath ?: File(normWs, cs.path).absolutePath)
                if (!cs.baselineExists) {
                    if (targetFile.exists()) {
                        deleteFileOnDisk(targetFile, wsRoot)
                        restoredFiles.add(cs.path)
                    }
                } else {
                    writeFileOnDisk(targetFile, cs.baseline)
                    restoredFiles.add(cs.path)
                }
            }
        }

        changesByWorkspace[normWs]?.clear()
        if (cp != null) {
            cp.files.clear()
            cp.files.putAll(cp.initialSnapshots.filterValues { it.isNotEmpty() })
            cp.initialSnapshots.keys.removeIf { cp.initialSnapshots[it].isNullOrEmpty() }
        }

        persistCheckpoint(normWs)
        persistStaging(normWs)
        pruneUnusedBlobs(normWs)
        notifyChange(normWs, "")
        return restoredFiles.toList()
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
        pruneUnusedBlobs(normWs)
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
        if (hash.isEmpty()) return ""
        val file = File(getBaselinesDir(workspace), hash)
        return if (file.exists()) {
            try { file.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
        } else {
            ""
        }
    }

    /**
     * Garbage-collects unreferenced baseline blobs in `.idea/review-hub/baselines`
     * to keep disk usage minimal.
     */
    private fun pruneUnusedBlobs(workspace: String) {
        val normWs = normalizeWorkspace(workspace)
        val baselinesDir = File(getWorkspaceDir(normWs), "baselines")
        if (!baselinesDir.exists() || !baselinesDir.isDirectory) return

        val referencedHashes = mutableSetOf<String>()
        checkpoints[normWs]?.let { cp ->
            referencedHashes.addAll(cp.files.values.filter { it.isNotEmpty() })
            referencedHashes.addAll(cp.initialSnapshots.values.filter { it.isNotEmpty() })
        }
        changesByWorkspace[normWs]?.values?.forEach { cs ->
            if (cs.baselineExists && cs.baseline.isNotEmpty()) {
                referencedHashes.add(sha256(cs.baseline))
            }
        }

        val blobFiles = baselinesDir.listFiles() ?: return
        for (blob in blobFiles) {
            if (blob.isFile && blob.name !in referencedHashes) {
                try { blob.delete() } catch (_: Exception) {}
            }
        }
    }

    private fun writeFileOnDisk(file: File, content: String) {
        try {
            file.parentFile?.mkdirs()
            file.writeText(content, Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    private fun deleteFileOnDisk(file: File, workspaceRoot: File) {
        if (file.exists()) {
            val deleted = file.delete()
            if (!deleted) {
                try {
                    Files.deleteIfExists(file.toPath())
                } catch (_: Exception) {}
            }
            cleanEmptyParentDirectories(file.parentFile, workspaceRoot)
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

            val cpFile = File(folder, "checkpoint.json")
            if (cpFile.exists()) {
                try {
                    val cp = json.decodeFromString<CheckpointRecord>(cpFile.readText(Charsets.UTF_8))
                    val normWs = normalizeWorkspace(cp.workspace)
                    checkpoints[normWs] = cp.copy(workspace = normWs)
                } catch (_: Exception) {}
            }

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

    private fun cleanEmptyParentDirectories(dir: File?, root: File) {
        var current = dir
        while (current != null && current != root && current.exists() && current.isDirectory) {
            val children = current.listFiles()
            if (children != null && children.isEmpty()) {
                val deleted = current.delete()
                if (!deleted) break
                current = current.parentFile
            } else {
                break
            }
        }
    }

    private fun sha256(input: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
        return HexFormat.of().formatHex(bytes)
    }
}

@Serializable
data class CheckpointRecord(
    val workspace: String,
    val setAt: Long,
    val files: MutableMap<String, String> = mutableMapOf(),
    val initialSnapshots: MutableMap<String, String> = mutableMapOf()
)
