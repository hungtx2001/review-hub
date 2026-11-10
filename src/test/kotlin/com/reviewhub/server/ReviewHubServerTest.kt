package com.reviewhub.server

import com.reviewhub.core.ChangeStore
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
            assertTrue(body.contains("get_review_status"))
            assertTrue(body.contains("rollback_checkpoint"))
        }
    }

    @Test
    fun testMcpProposeLiveDiskSyncAndAccept() {
        val sampleFile = File(workspaceDir, "Hello.kt")
        sampleFile.writeText("fun main() {\n    println(\"Hello World\")\n}\n")

        // 1. Propose edit
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
            assertEquals(true, toolRes["diskSynced"]?.jsonPrimitive?.booleanOrNull)
        }

        // Check that disk is immediately synced so AI build/run/test tools see the new code
        val onDiskDuringStaging = sampleFile.readText()
        assertTrue(onDiskDuringStaging.contains("Hello Review Hub"))

        // Check read_file returns staged content and supports start_line/end_line
        val staged = store.readFile(workspaceDir.absolutePath, "Hello.kt")
        assertTrue(staged.contains("Hello Review Hub"))
        val slice = store.readFile(workspaceDir.absolutePath, "Hello.kt", startLine = 2, endLine = 2)
        assertEquals("    println(\"Hello Review Hub\")", slice)

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

        // Disk retains accepted content and change list is now empty
        val onDiskAfter = sampleFile.readText()
        assertTrue(onDiskAfter.contains("Hello Review Hub"))
        assertTrue(store.listChanges(workspaceDir.absolutePath).isEmpty())
    }

    @Test
    fun testMcpProposeDeleteAndRejectRestoresFile() {
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

        // File is deleted on disk during staging so AI builds verify deletion
        assertFalse(fileToDelete.exists())

        // Rejecting the deletion restores the file on disk from baseline snapshot
        val rejectCall = """
        {
          "jsonrpc": "2.0",
          "id": 6,
          "method": "tools/call",
          "params": {
            "name": "reject",
            "arguments": {
              "changeId": "$changeId"
            }
          }
        }
        """.trimIndent()

        val req2 = Request.Builder()
            .url("http://127.0.0.1:${server.port}/mcp")
            .post(rejectCall.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(req2).execute().use { resp ->
            assertTrue(resp.isSuccessful)
        }

        assertTrue("File should be restored to disk after rejecting propose_delete", fileToDelete.exists())
        assertEquals("class Obsolete", fileToDelete.readText())
    }
}
