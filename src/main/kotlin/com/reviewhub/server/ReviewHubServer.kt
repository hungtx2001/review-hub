package com.reviewhub.server

import com.reviewhub.core.ChangeStore
import com.reviewhub.model.*
import com.reviewhub.util.FuzzyMatchUtil
import com.reviewhub.util.PathUtil
import com.reviewhub.util.ReviewHubPaths
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpHandler
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.File
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.nio.file.Paths
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class ReviewHubServer(
    val store: ChangeStore,
    private val preferredPort: Int = 49182,
    private val workspacePath: String? = null
) {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true; isLenient = true }
    private val compactJson = Json { prettyPrint = false; ignoreUnknownKeys = true; isLenient = true }
    private var server: HttpServer? = null
    var port: Int = preferredPort
        private set
    var token: String = UUID.randomUUID().toString()
        private set

    // Active SSE sessions: sessionId -> HttpExchange
    private val sseSessions = ConcurrentHashMap<String, HttpExchange>()

    fun start(): Int {
        if (!workspacePath.isNullOrBlank()) {
            store.registerWorkspace(workspacePath)
        }
        var boundPort = preferredPort
        var createdServer: HttpServer? = null

        // Try ports from preferredPort to preferredPort + 10
        for (candidate in preferredPort..(preferredPort + 10)) {
            try {
                createdServer = HttpServer.create(InetSocketAddress("127.0.0.1", candidate), 0)
                boundPort = candidate
                break
            } catch (_: Exception) {}
        }

        if (createdServer == null) {
            createdServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            boundPort = createdServer.address.port
        }

        server = createdServer
        port = boundPort
        server?.executor = Executors.newCachedThreadPool()

        registerRoutes(createdServer)
        createdServer.start()

        writeHubJson()
        return port
    }

    fun stop() {
        for ((_, session) in sseSessions) {
            try { session.close() } catch (_: Exception) {}
        }
        sseSessions.clear()
        server?.stop(0)
        server = null
        removeHubJson()
    }

    private fun registerRoutes(srv: HttpServer) {
        srv.createContext("/healthz") { exchange ->
            sendJson(exchange, 200, buildJsonObject {
                put("ok", true)
                put("version", getVersion())
                put("port", port)
            })
        }

        srv.createContext("/workspaces") { exchange ->
            val list = store.listWorkspaces().toMutableList()
            if (workspacePath != null && workspacePath !in list) {
                list.add(0, workspacePath)
            }
            sendJson(exchange, 200, buildJsonObject {
                putJsonArray("workspaces") {
                    for (ws in list) add(ws)
                }
            })
        }

        srv.createContext("/changes/list") { exchange ->
            val params = parseQueryParams(exchange.requestURI.query)
            val ws = params["workspace"] ?: workspacePath ?: ""
            if (ws.isNotBlank()) {
                store.registerWorkspace(ws)
            }
            val changes = store.listChanges(ws)
            sendJson(exchange, 200, json.encodeToJsonElement(ListChangesResponse(changes)))
        }

        srv.createContext("/changes/get") { exchange ->
            val params = parseQueryParams(exchange.requestURI.query)
            val changeId = params["changeId"] ?: ""
            val ws = params["workspace"] ?: workspacePath
            val cs = store.getChange(changeId, ws)
            if (cs != null) {
                sendJson(exchange, 200, json.encodeToJsonElement(GetChangeResponse(cs)))
            } else {
                sendJson(exchange, 404, buildJsonObject { put("error", "Change not found") })
            }
        }

        srv.createContext("/changes/propose") { exchange ->
            if (exchange.requestMethod.equals("POST", ignoreCase = true)) {
                val body = readRequestBody(exchange)
                val obj = json.parseToJsonElement(body).jsonObject
                val rawWs = obj["workspace"]?.jsonPrimitive?.contentOrNull
                val rawPath = obj["path"]?.jsonPrimitive?.content ?: ""
                val content = obj["content"]?.jsonPrimitive?.content ?: ""
                val proposedExists = obj["proposedExists"]?.jsonPrimitive?.booleanOrNull ?: true
                val (ws, path) = resolveWorkspaceAndPath(rawWs, rawPath)
                val cs = store.propose(ws, path, content, proposedExists)
                sendJson(exchange, 200, buildJsonObject {
                    put("changeId", cs.id)
                    put("path", cs.path)
                    put("status", "staged_for_review")
                    put("hunks", json.encodeToJsonElement(cs.hunks))
                })
            } else {
                sendJson(exchange, 405, buildJsonObject { put("error", "Method Not Allowed") })
            }
        }

        srv.createContext("/changes/accept") { exchange ->
            if (exchange.requestMethod.equals("POST", ignoreCase = true)) {
                val body = readRequestBody(exchange)
                val req = json.decodeFromString<DecideRequest>(body)
                val res = store.accept(req.changeId, req.workspace ?: workspacePath, req.path, req.hunkIds, req.customContent)
                if (res != null) {
                    sendJson(exchange, 200, json.encodeToJsonElement(res))
                } else {
                    sendJson(exchange, 404, buildJsonObject { put("error", "Change not found") })
                }
            } else {
                sendJson(exchange, 405, buildJsonObject { put("error", "Method Not Allowed") })
            }
        }

        srv.createContext("/changes/reject") { exchange ->
            if (exchange.requestMethod.equals("POST", ignoreCase = true)) {
                val body = readRequestBody(exchange)
                val req = json.decodeFromString<DecideRequest>(body)
                val res = store.reject(req.changeId, req.workspace ?: workspacePath, req.path, req.hunkIds)
                if (res != null) {
                    sendJson(exchange, 200, json.encodeToJsonElement(res))
                } else {
                    sendJson(exchange, 404, buildJsonObject { put("error", "Change not found") })
                }
            } else {
                sendJson(exchange, 405, buildJsonObject { put("error", "Method Not Allowed") })
            }
        }

        srv.createContext("/checkpoint/set") { exchange ->
            val body = readRequestBody(exchange)
            val obj = if (body.isNotEmpty()) json.parseToJsonElement(body).jsonObject else JsonObject(emptyMap())
            val ws = obj["workspace"]?.jsonPrimitive?.content ?: workspacePath ?: ""
            val info = store.setCheckpoint(ws)
            sendJson(exchange, 200, json.encodeToJsonElement(info))
        }

        srv.createContext("/checkpoint/clear") { exchange ->
            val body = readRequestBody(exchange)
            val obj = if (body.isNotEmpty()) json.parseToJsonElement(body).jsonObject else JsonObject(emptyMap())
            val ws = obj["workspace"]?.jsonPrimitive?.content ?: workspacePath ?: ""
            val ok = store.clearCheckpoint(ws)
            sendJson(exchange, 200, buildJsonObject { put("ok", ok) })
        }

        srv.createContext("/checkpoint/rollback") { exchange ->
            val body = readRequestBody(exchange)
            val obj = if (body.isNotEmpty()) json.parseToJsonElement(body).jsonObject else JsonObject(emptyMap())
            val ws = obj["workspace"]?.jsonPrimitive?.content ?: workspacePath ?: ""
            val files = store.rollbackToCheckpoint(ws)
            sendJson(exchange, 200, buildJsonObject {
                put("reverted", files.size)
                put("files", json.encodeToJsonElement(files))
            })
        }

        srv.createContext("/changes/status") { exchange ->
            val params = parseQueryParams(exchange.requestURI.query)
            val ws = params["workspace"] ?: workspacePath ?: ""
            val path = params["path"]
            val changeId = params["changeId"]
            val status = store.getReviewStatus(ws, path, changeId)
            sendJson(exchange, 200, json.encodeToJsonElement(status))
        }

        srv.createContext("/checkpoint/info") { exchange ->
            val params = parseQueryParams(exchange.requestURI.query)
            val ws = params["workspace"] ?: workspacePath ?: ""
            val info = store.checkpointInfo(ws)
            sendJson(exchange, 200, buildJsonObject {
                put("checkpoint", if (info != null) json.encodeToJsonElement(info) else JsonNull)
            })
        }

        srv.createContext("/file/read") { exchange ->
            val params = parseQueryParams(exchange.requestURI.query)
            val ws = params["workspace"] ?: workspacePath ?: ""
            val path = params["path"] ?: ""
            val content = store.readFile(ws, path)
            sendJson(exchange, 200, buildJsonObject {
                put("exists", content.isNotEmpty() || File(ws, path).exists())
                put("content", content)
            })
        }

        // ================= MCP PROTOCOL (SSE & JSON-RPC) =================
        srv.createContext("/sse") { exchange ->
            handleMcpSse(exchange)
        }

        srv.createContext("/message") { exchange ->
            handleMcpMessage(exchange)
        }

        srv.createContext("/mcp") { exchange ->
            // Direct Streamable HTTP MCP endpoint
            handleMcpMessage(exchange)
        }
    }

    private fun handleMcpSse(exchange: HttpExchange) {
        val sessionId = UUID.randomUUID().toString()
        val headers = exchange.responseHeaders
        headers.set("Content-Type", "text/event-stream; charset=utf-8")
        headers.set("Cache-Control", "no-cache")
        headers.set("Connection", "keep-alive")
        headers.set("Access-Control-Allow-Origin", "*")

        exchange.sendResponseHeaders(200, 0)
        val os = exchange.responseBody

        // Initial SSE endpoint event as per MCP specification
        val endpointEvent = "event: endpoint\ndata: /message?sessionId=$sessionId\n\n"
        os.write(endpointEvent.toByteArray(StandardCharsets.UTF_8))
        os.flush()

        sseSessions[sessionId] = exchange
    }

    private fun handleMcpMessage(exchange: HttpExchange) {
        exchange.responseHeaders.set("Access-Control-Allow-Origin", "*")
        exchange.responseHeaders.set("Access-Control-Allow-Headers", "*")
        exchange.responseHeaders.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

        if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            exchange.sendResponseHeaders(204, -1)
            return
        }

        val body = readRequestBody(exchange)
        if (body.isEmpty()) {
            exchange.sendResponseHeaders(400, -1)
            return
        }

        val requestElement = json.parseToJsonElement(body)
        if (requestElement !is JsonObject) {
            exchange.sendResponseHeaders(400, -1)
            return
        }

        val id = requestElement["id"]
        val method = requestElement["method"]?.jsonPrimitive?.content ?: ""
        val params = requestElement["params"]?.jsonObject ?: JsonObject(emptyMap())
        val queryParams = parseQueryParams(exchange.requestURI.query)
        val sessionId = queryParams["sessionId"]

        if (id == null && method.startsWith("notifications/")) {
            exchange.sendResponseHeaders(202, -1)
            exchange.close()
            return
        }

        val responseJson = processMcpMethod(id, method, params)

        if (sessionId != null) {
            val sseExchange = sseSessions[sessionId]
            if (sseExchange != null) {
                try {
                    val sseData = "event: message\ndata: ${compactJson.encodeToString(responseJson)}\n\n"
                    synchronized(sseExchange) {
                        sseExchange.responseBody.write(sseData.toByteArray(StandardCharsets.UTF_8))
                        sseExchange.responseBody.flush()
                    }
                } catch (_: Exception) {
                    sseSessions.remove(sessionId)
                    try { sseExchange.close() } catch (_: Exception) {}
                }
            }
        }

        sendJson(exchange, 200, responseJson)
    }

    private fun processMcpMethod(id: JsonElement?, method: String, params: JsonObject): JsonObject {
        return when (method) {
            "initialize" -> {
                buildJsonObject {
                    put("jsonrpc", "2.0")
                    if (id != null) put("id", id)
                    putJsonObject("result") {
                        put("protocolVersion", "2024-11-05")
                        putJsonObject("capabilities") {
                            putJsonObject("tools") {
                                put("listChanged", true)
                            }
                        }
                        putJsonObject("serverInfo") {
                            put("name", "review-hub")
                            put("version", getVersion())
                        }
                    }
                }
            }

            "notifications/initialized" -> {
                buildJsonObject {
                    put("jsonrpc", "2.0")
                    if (id != null) put("id", id)
                    putJsonObject("result") {}
                }
            }

            "tools/list" -> {
                buildJsonObject {
                    put("jsonrpc", "2.0")
                    if (id != null) put("id", id)
                    putJsonObject("result") {
                        putJsonArray("tools") {
                            add(toolSchema(
                                "propose_edit",
                                "Propose editing part of a file (staged for review in JetBrains IDE).",
                                mapOf(
                                    "path" to "string",
                                    "old_string" to "string",
                                    "new_string" to "string",
                                    "replace_all" to "boolean",
                                    "workspace" to "string"
                                ),
                                listOf("path", "old_string", "new_string")
                            ))
                            add(toolSchema(
                                "propose_write",
                                "Propose creating or overwriting a file (staged for review in JetBrains IDE).",
                                mapOf(
                                    "path" to "string",
                                    "content" to "string",
                                    "workspace" to "string"
                                ),
                                listOf("path", "content")
                            ))
                            add(toolSchema(
                                "propose_delete",
                                "Propose deleting a file (staged for review in JetBrains IDE).",
                                mapOf(
                                    "path" to "string",
                                    "workspace" to "string"
                                ),
                                listOf("path")
                            ))
                            add(toolSchema(
                                "read_file",
                                "Read a file through the staged review state.",
                                mapOf(
                                    "path" to "string",
                                    "workspace" to "string"
                                ),
                                listOf("path")
                            ))
                            add(toolSchema(
                                "list_changes",
                                "List all pending changes and hunks awaiting review in Review Hub.",
                                mapOf("workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "get_change",
                                "Inspect detailed hunks and unified diff for any pending change.",
                                mapOf("changeId" to "string", "workspace" to "string"),
                                listOf("changeId")
                            ))
                            add(toolSchema(
                                "accept",
                                "Accept specific hunks or entire files (writes to disk).",
                                mapOf("changeId" to "string", "path" to "string", "workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "reject",
                                "Reject specific hunks or revert files to baseline.",
                                mapOf("changeId" to "string", "path" to "string", "workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "set_checkpoint",
                                "Accept current disk state as the baseline.",
                                mapOf("workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "clear_checkpoint",
                                "Clear the current checkpoint baseline.",
                                mapOf("workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "rollback_checkpoint",
                                "Rollback all files in the workspace to the initial checkpoint state, undoing AI changes.",
                                mapOf("workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "get_review_status",
                                "Check review status of staged changes (e.g. pending, applied, rejected) by file path or change ID.",
                                mapOf("path" to "string", "changeId" to "string", "workspace" to "string"),
                                emptyList()
                            ))
                            add(toolSchema(
                                "list_workspaces",
                                "List all active workspaces tracked by Review Hub.",
                                emptyMap(),
                                emptyList()
                            ))
                        }
                    }
                }
            }

            "tools/call" -> {
                val toolName = params["name"]?.jsonPrimitive?.content ?: ""
                val args = params["arguments"]?.jsonObject ?: JsonObject(emptyMap())
                val toolResult = executeMcpTool(toolName, args)

                buildJsonObject {
                    put("jsonrpc", "2.0")
                    if (id != null) put("id", id)
                    putJsonObject("result") {
                        putJsonArray("content") {
                            addJsonObject {
                                put("type", "text")
                                put("text", toolResult)
                            }
                        }
                    }
                }
            }

            else -> {
                buildJsonObject {
                    put("jsonrpc", "2.0")
                    if (id != null) put("id", id)
                    putJsonObject("error") {
                        put("code", -32601)
                        put("message", "Method not found: $method")
                    }
                }
            }
        }
    }

    private fun resolveWorkspaceAndPath(explicitWs: String?, rawPath: String): Pair<String, String> {
        val candidates = (store.listWorkspaces() + listOfNotNull(workspacePath))
            .map { PathUtil.normalizeWorkspace(it) }
            .filter { it.isNotEmpty() }
            .distinct()

        if (!explicitWs.isNullOrBlank()) {
            val normWs = PathUtil.normalizeWorkspace(explicitWs)
            return Pair(normWs, PathUtil.toWorkspaceRelativePath(normWs, rawPath))
        }

        if (rawPath.isNotBlank()) {
            // 1. Check if rawPath is an absolute path inside one of the known workspaces
            for (ws in candidates.sortedByDescending { it.length }) {
                val rel = PathUtil.toRelativePath(ws, rawPath)
                if (rel != null) {
                    return Pair(ws, rel)
                }
            }

            // 2. Check if rawPath matches an active staged change or existing file in a known workspace
            val defaultWs = PathUtil.normalizeWorkspace(workspacePath ?: candidates.firstOrNull() ?: "")
            if (candidates.size > 1) {
                val matchedWs = candidates.firstOrNull { ws ->
                    store.findChangeByPath(ws, rawPath) != null
                } ?: candidates.firstOrNull { ws ->
                    File(ws, PathUtil.toWorkspaceRelativePath(ws, rawPath)).exists()
                }
                if (matchedWs != null) {
                    return Pair(matchedWs, PathUtil.toWorkspaceRelativePath(matchedWs, rawPath))
                }
            }
            return Pair(defaultWs, PathUtil.toWorkspaceRelativePath(defaultWs, rawPath))
        }

        val fallbackWs = PathUtil.normalizeWorkspace(workspacePath ?: candidates.firstOrNull() ?: "")
        return Pair(fallbackWs, "")
    }

    private fun executeMcpTool(name: String, args: JsonObject): String {
        val explicitWs = args["workspace"]?.jsonPrimitive?.contentOrNull
        val rawPath = args["path"]?.jsonPrimitive?.contentOrNull ?: ""
        val (targetWs, targetPath) = resolveWorkspaceAndPath(explicitWs, rawPath)

        return when (name) {
            "propose_edit" -> {
                val oldString = args["old_string"]?.jsonPrimitive?.content ?: ""
                val newString = args["new_string"]?.jsonPrimitive?.content ?: ""
                val replaceAll = args["replace_all"]?.jsonPrimitive?.booleanOrNull ?: false
                val currentText = store.readFile(targetWs, targetPath)

                val replaced = FuzzyMatchUtil.findAndReplace(currentText, oldString, newString, replaceAll)
                if (replaced == null) {
                    return json.encodeToString(buildJsonObject {
                        put("status", "error")
                        put("error", "Target old_string not found in file: $targetPath")
                    })
                }

                val cs = store.propose(targetWs, targetPath, replaced, proposedExists = true)
                json.encodeToString(buildJsonObject {
                    put("status", "staged_for_review")
                    put("changeId", cs.id)
                    put("hunks", cs.hunks.size)
                })
            }

            "propose_write" -> {
                val content = args["content"]?.jsonPrimitive?.content ?: ""
                val cs = store.propose(targetWs, targetPath, content, proposedExists = true)
                json.encodeToString(buildJsonObject {
                    put("status", "staged_for_review")
                    put("changeId", cs.id)
                    put("hunks", cs.hunks.size)
                })
            }

            "propose_delete" -> {
                val cs = store.propose(targetWs, targetPath, "", proposedExists = false)
                json.encodeToString(buildJsonObject {
                    put("status", "staged_for_review")
                    put("changeId", cs.id)
                    put("deleted", true)
                })
            }

            "read_file" -> {
                store.readFile(targetWs, targetPath)
            }

            "list_changes" -> {
                val changes = store.listChanges(targetWs)
                json.encodeToString(changes)
            }

            "get_change" -> {
                val changeId = args["changeId"]?.jsonPrimitive?.content ?: ""
                val cs = store.getChange(changeId, targetWs)
                if (cs != null) json.encodeToString(cs) else "{\"error\": \"Not found\"}"
            }

            "accept" -> {
                val changeId = args["changeId"]?.jsonPrimitive?.content
                val res = store.accept(changeId, targetWs, targetPath)
                if (res != null) json.encodeToString(res) else "{\"error\": \"Not found\"}"
            }

            "reject" -> {
                val changeId = args["changeId"]?.jsonPrimitive?.content
                val res = store.reject(changeId, targetWs, targetPath)
                if (res != null) json.encodeToString(res) else "{\"error\": \"Not found\"}"
            }

            "set_checkpoint" -> {
                val info = store.setCheckpoint(targetWs)
                json.encodeToString(info)
            }

            "clear_checkpoint" -> {
                val ok = store.clearCheckpoint(targetWs)
                "{\"ok\": $ok}"
            }

            "rollback_checkpoint" -> {
                val files = store.rollbackToCheckpoint(targetWs)
                "{\"status\": \"rolled_back\", \"files_reverted\": ${files.size}}"
            }

            "get_review_status" -> {
                val path = args["path"]?.jsonPrimitive?.contentOrNull
                val changeId = args["changeId"]?.jsonPrimitive?.contentOrNull
                val status = store.getReviewStatus(targetWs, path, changeId)
                json.encodeToString(status)
            }

            "list_workspaces" -> {
                json.encodeToString(store.listWorkspaces())
            }

            else -> "{\"error\": \"Unknown tool: $name\"}"
        }
    }

    private fun toolSchema(name: String, description: String, properties: Map<String, String>, required: List<String>): JsonObject {
        return buildJsonObject {
            put("name", name)
            put("description", description)
            putJsonObject("inputSchema") {
                put("type", "object")
                putJsonObject("properties") {
                    for ((k, v) in properties) {
                        putJsonObject(k) {
                            put("type", v)
                        }
                    }
                }
                if (required.isNotEmpty()) {
                    putJsonArray("required") {
                        for (r in required) add(r)
                    }
                }
            }
        }
    }

    private fun writeHubJson() {
        val hubFile = ReviewHubPaths.getHubJsonFile()
        try {
            hubFile.parentFile?.mkdirs()
            val entry = HubEntry(
                url = "http://127.0.0.1:$port",
                token = token,
                pid = ProcessHandle.current().pid(),
                workspace = workspacePath,
                updatedAt = System.currentTimeMillis()
            )
            hubFile.writeText(json.encodeToString(entry), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    private fun removeHubJson() {
        val hubFile = ReviewHubPaths.getHubJsonFile()
        if (hubFile.exists()) {
            try { hubFile.delete() } catch (_: Exception) {}
        }
    }

    private fun sendJson(exchange: HttpExchange, statusCode: Int, jsonElement: JsonElement) {
        val responseBytes = json.encodeToString(jsonElement).toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(statusCode, responseBytes.size.toLong())
        exchange.responseBody.use { it.write(responseBytes) }
    }

    private fun readRequestBody(exchange: HttpExchange): String {
        return exchange.requestBody.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
    }

    private fun parseQueryParams(query: String?): Map<String, String> {
        if (query == null || query.isEmpty()) return emptyMap()
        val map = mutableMapOf<String, String>()
        for (param in query.split("&")) {
            val parts = param.split("=", limit = 2)
            if (parts.size == 2) {
                map[URLDecoder.decode(parts[0], "UTF-8")] = URLDecoder.decode(parts[1], "UTF-8")
            }
        }
        return map
    }

    companion object {
        fun getVersion(): String {
            return try {
                val pluginId = com.intellij.openapi.extensions.PluginId.getId("com.reviewhub.jetbrains")
                com.intellij.ide.plugins.PluginManager.getInstance().findEnabledPlugin(pluginId)?.version ?: "0.1.0"
            } catch (_: Throwable) {
                "0.1.0"
            }
        }
    }
}
