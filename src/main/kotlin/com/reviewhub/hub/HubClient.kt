package com.reviewhub.hub

import com.reviewhub.model.*
import com.reviewhub.util.PathUtil
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class HubClient(
    val baseUrl: String,
    val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    fun healthCheck(): Boolean {
        val req = Request.Builder()
            .url("$baseUrl/healthz")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun listChanges(workspace: String): List<ChangeSummary> {
        val candidates = PathUtil.normalizeWorkspaceCandidates(workspace)

        for (ws in candidates) {
            val list = fetchList(ws)
            if (list.isNotEmpty()) return list
        }
        return emptyList()
    }

    private fun fetchList(workspace: String): List<ChangeSummary> {
        val encodedWs = URLEncoder.encode(workspace, "UTF-8")
        val url = "$baseUrl/changes/list?workspace=$encodedWs"
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val body = resp.body?.string() ?: return emptyList()
                json.decodeFromString<ListChangesResponse>(body).files
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun propose(workspace: String, path: String, content: String): Boolean {
        val normalizedWs = workspace.replace('\\', '/')
        val map = mapOf(
            "workspace" to normalizedWs,
            "path" to path.replace('\\', '/'),
            "content" to content
        )
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/changes/propose")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun getChange(changeId: String, workspace: String? = null): ChangeSet? {
        val encodedId = URLEncoder.encode(changeId, "UTF-8")
        
        // 1. Try with workspace if provided
        if (workspace != null) {
            val encodedWs = URLEncoder.encode(workspace, "UTF-8")
            val url = "$baseUrl/changes/get?changeId=$encodedId&workspace=$encodedWs"
            val cs = fetchChangeSet(url)
            if (cs != null) return cs

            // Also try with forward slash normalized workspace
            val normWs = workspace.replace('\\', '/')
            if (normWs != workspace) {
                val urlNorm = "$baseUrl/changes/get?changeId=$encodedId&workspace=${URLEncoder.encode(normWs, "UTF-8")}"
                val csNorm = fetchChangeSet(urlNorm)
                if (csNorm != null) return csNorm
            }
        }

        // 2. Fallback to scanning by changeId across all workspaces
        val fallbackUrl = "$baseUrl/changes/get?changeId=$encodedId"
        return fetchChangeSet(fallbackUrl)
    }

    private fun fetchChangeSet(url: String): ChangeSet? {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                json.decodeFromString<GetChangeResponse>(body).changeSet
            }
        } catch (_: Exception) {
            null
        }
    }

    fun accept(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        val normWs = workspace?.replace('\\', '/')
        val normPath = path?.replace('\\', '/')
        return decide("/changes/accept", DecideRequest(changeId, normPath, normWs, hunkIds))
    }

    fun reject(changeId: String? = null, workspace: String? = null, path: String? = null, hunkIds: List<String>? = null): DecideResult? {
        val normWs = workspace?.replace('\\', '/')
        val normPath = path?.replace('\\', '/')
        return decide("/changes/reject", DecideRequest(changeId, normPath, normWs, hunkIds))
    }

    private fun decide(endpoint: String, request: DecideRequest): DecideResult? {
        val bodyStr = json.encodeToString(request)
        val req = Request.Builder()
            .url("$baseUrl$endpoint")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                json.decodeFromString<DecideResult>(body)
            }
        } catch (_: Exception) {
            null
        }
    }

    fun setCheckpoint(workspace: String): Boolean {
        val map = mapOf("workspace" to workspace.replace('\\', '/'))
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/checkpoint/set")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    fun clearCheckpoint(workspace: String): Boolean {
        val map = mapOf("workspace" to workspace.replace('\\', '/'))
        val bodyStr = json.encodeToString(map)
        val req = Request.Builder()
            .url("$baseUrl/checkpoint/clear")
            .header("Authorization", "Bearer $token")
            .post(bodyStr.toRequestBody(jsonMediaType))
            .build()

        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }
}
