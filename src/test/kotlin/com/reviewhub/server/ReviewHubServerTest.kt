package com.reviewhub.server

import com.reviewhub.core.ChangeStore
import com.reviewhub.core.HunkDiff
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ReviewHubServerTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var workspaceDir: File
    private lateinit var store: ChangeStore
    private lateinit var server: ReviewHubServer
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() {
        workspaceDir = tempFolder.newFolder("test-workspace")
        store = ChangeStore()
        server = ReviewHubServer(store, preferredPort = 49195, workspacePath = workspaceDir.absolutePath)
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
    }

    @Test
    fun testHealthz() {
        val req = Request.Builder()
            .url("http://127.0.0.1:${server.port}/healthz")
            .get()
            .build()

        client.newCall(req).execute().use { resp ->
            assertTrue(resp.isSuccessful)
            val body = resp.body?.string() ?: ""
            assertTrue(body.contains("\"ok\": true"))
        }
    }

    @Test
    fun testMcpInitializeAndToolsList() {
        // 1. Test initialize
        val initJson = """
        {
          "jsonrpc": "2.0",
          "id": 1,
          "method": "initialize",
          "params": {}
        }
        """.trimIndent()

        val req1 = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(initJson.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req1).execute().use { resp ->
            assertTrue(resp.isSuccessful)
            val body = resp.body?.string() ?: ""
            assertTrue(body.contains("\"name\": \"review-hub\""))
        }

        // 2. Test tools/list
        val listJson = """
        {
          "jsonrpc": "2.0",
          "id": 2,
          "method": "tools/list",
          "params": {}
        }
        """.trimIndent()

        val req2 = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(listJson.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req2).execute().use { resp ->
            assertTrue(resp.isSuccessful)
            val body = resp.body?.string() ?: ""
            assertTrue(body.contains("propose_edit"))
            assertTrue(body.contains("propose_write"))
            assertTrue(body.contains("read_file"))
        }
    }

    @Test
    fun testMcpProposeAndAccept() {
        val sampleFile = File(workspaceDir, "Hello.kt")
        sampleFile.writeText("fun main() {\n    println(\"Hello World\")\n}\n")

        // 1. Propose write
        val proposeCall = """
        {
          "jsonrpc": "2.0",
          "id": 3,
          "method": "tools/call",
          "params": {
            "name": "propose_edit",
            "arguments": {
              "path": "Hello.kt",
              "old_string": "Hello World",
              "new_string": "Hello Review Hub"
            }
          }
        }
        """.trimIndent()

        val req = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(proposeCall.toRequestBody("application/json".toMediaType()))
            .build()

        var changeId = ""
        client.newCall(req).execute().use { resp ->
            assertTrue(resp.isSuccessful)
            val body = resp.body?.string() ?: ""
            assertTrue(body.contains("staged_for_review"))
            val obj = json.parseToJsonElement(body).jsonObject
            val contentText = obj["result"]?.jsonObject?.get("content")?.jsonArray?.get(0)?.jsonObject?.get("text")?.jsonPrimitive?.content ?: ""
            val toolRes = json.parseToJsonElement(contentText).jsonObject
            changeId = toolRes["changeId"]?.jsonPrimitive?.content ?: ""
            assertTrue(changeId.isNotEmpty())
        }

        // Check that disk is still untouched (staged in review hub!)
        val onDiskBefore = sampleFile.readText()
        assertTrue(onDiskBefore.contains("Hello World"))

        // Check read_file returns staged content
        val staged = store.readFile(workspaceDir.absolutePath, "Hello.kt")
        assertTrue(staged.contains("Hello Review Hub"))

        // 2. Accept change
        val acceptCall = """
        {
          "jsonrpc": "2.0",
          "id": 4,
          "method": "tools/call",
          "params": {
            "name": "accept",
            "arguments": {
              "changeId": "$changeId",
              "path": "Hello.kt"
            }
          }
        }
        """.trimIndent()

        val req2 = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(acceptCall.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req2).execute().use { resp ->
            assertTrue(resp.isSuccessful)
        }

        // Now disk has been accepted and written!
        val onDiskAfter = sampleFile.readText()
        assertTrue(onDiskAfter.contains("Hello Review Hub"))
    }

    @Test
    fun testMcpProposeDeleteAndAbsolutePathRouting() {
        val fileToDelete = File(workspaceDir, "Obsolete.kt")
        fileToDelete.writeText("class Obsolete")

        val absPath = fileToDelete.absolutePath.replace('\\', '/')
        val deleteCall = """
        {
          "jsonrpc": "2.0",
          "id": 5,
          "method": "tools/call",
          "params": {
            "name": "propose_delete",
            "arguments": {
              "path": "$absPath"
            }
          }
        }
        """.trimIndent()

        val req = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(deleteCall.toRequestBody("application/json".toMediaType()))
            .build()

        var changeId = ""
        client.newCall(req).execute().use { resp ->
            assertTrue(resp.isSuccessful)
            val body = resp.body?.string() ?: ""
            val obj = json.parseToJsonElement(body).jsonObject
            val contentText = obj["result"]?.jsonObject?.get("content")?.jsonArray?.get(0)?.jsonObject?.get("text")?.jsonPrimitive?.content ?: ""
            val toolRes = json.parseToJsonElement(contentText).jsonObject
            changeId = toolRes["changeId"]?.jsonPrimitive?.content ?: ""
            assertTrue(changeId.isNotEmpty())
        }

        // File still exists before accept
        assertTrue(fileToDelete.exists())

        // Accept the deletion
        val acceptCall = """
        {
          "jsonrpc": "2.0",
          "id": 6,
          "method": "tools/call",
          "params": {
            "name": "accept",
            "arguments": {
              "changeId": "$changeId"
            }
          }
        }
        """.trimIndent()

        val req2 = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(acceptCall.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req2).execute().use { resp ->
            assertTrue(resp.isSuccessful)
        }

        assertFalse("File should be deleted from disk after accepting propose_delete", fileToDelete.exists())
    }
}

