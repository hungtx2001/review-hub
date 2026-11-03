package com.reviewhub.model

import kotlinx.serialization.Serializable

@Serializable
data class Hunk(
    val id: String,
    val oldStart: Int,
    val oldLines: List<String> = emptyList(),
    val newStart: Int,
    val newLines: List<String> = emptyList(),
    val decision: String = "pending"
)

@Serializable
data class ChangeSet(
    val id: String,
    val workspace: String,
    val path: String,
    val absPath: String? = null,
    val origin: String = "mcp",
    val applied: Boolean = false,
    val binary: Boolean = false,
    val baseline: String = "",
    val proposed: String = "",
    val baselineExists: Boolean = true,
    val proposedExists: Boolean = true,
    val hunks: List<Hunk> = emptyList(),
    val status: String = "pending",
    val createdAt: Long = 0,
    val updatedAt: Long = 0
)

@Serializable
data class ChangeSummary(
    val id: String,
    val workspace: String,
    val path: String,
    val origin: String = "mcp",
    val applied: Boolean = false,
    val status: String = "pending",
    val binary: Boolean = false,
    val added: Int = 0,
    val removed: Int = 0,
    val accepted: Int = 0,
    val rejected: Int = 0,
    val pending: Int = 0
)

@Serializable
data class HubEntry(
    val url: String,
    val token: String,
    val pid: Long,
    val workspace: String? = null,
    val updatedAt: Long = 0,
    val protocol: Int = 1
)

@Serializable
data class ListChangesResponse(
    val files: List<ChangeSummary> = emptyList()
)

@Serializable
data class GetChangeResponse(
    val changeSet: ChangeSet
)

@Serializable
data class DecideResult(
    val changeId: String,
    val status: String,
    val resolved: Boolean,
    val remaining: Int,
    val hunks: List<Hunk> = emptyList()
)

@Serializable
data class DecideRequest(
    val changeId: String? = null,
    val path: String? = null,
    val workspace: String? = null,
    val hunkIds: List<String>? = null
)

@Serializable
data class CheckpointInfo(
    val workspace: String,
    val setAt: Long
)
