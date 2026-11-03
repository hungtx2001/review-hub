package com.reviewhub.mcp

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Paths

data class ConfigurationResult(
    val updatedTools: List<String>,
    val removedTools: List<String>,
    val rulesInstalled: List<String>,
    val errors: List<String>
)

object AiToolConfigManager {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    const val DEFAULT_PORT = 49182
    const val MCP_SSE_URL = "http://127.0.0.1:$DEFAULT_PORT/sse"

    const val MCP_JSON_SNIPPET = """{
  "mcpServers": {
    "review-hub": {
      "url": "http://127.0.0.1:49182/sse"
    }
  }
}"""

    const val MCP_TOML_SNIPPET = """[mcp.servers."review-hub"]
url = "http://127.0.0.1:49182/sse""""

    const val AGENT_RULES_CONTENT = """<!-- review-hub:start -->
## Review Hub (required)

This project uses Review Hub to review AI edits. **Do not use the built-in `edit`, `write`, or shell commands to modify source files.** Use the Review Hub MCP tools instead, so every change is recorded and the user can accept or reject each hunk:

- `propose_edit` (or `mcp__review_hub__propose_edit`) — change a file. Same arguments as the native edit tool: `path`, `old_string`, `new_string`, optional `replace_all`.
  **Use this instead of `edit`.**
- `propose_write` (or `mcp__review_hub__propose_write`) — create or replace a whole file (`path`, `content`).
  **Use this instead of `write`.**
- `propose_delete` (or `mcp__review_hub__propose_delete`) — delete a file (`path`).
  **Use this instead of `rm`.**
- `read_file` (or `mcp__review_hub__read_file`) — read a file (`path`).
- `list_changes` (or `mcp__review_hub__list_changes`) — list files changed since the last accepted checkpoint.
- Review Hub **does not write your edit to disk until the user accepts it**. Reading the file with your own tools will show the OLD content — that is expected, not a failed edit.
- Use the `read_file` tool (not `cat`/Read) to see the content you have staged so far.

A `propose_*` call returns `status: "staged_for_review"` with a `changeId`. That is **success, not an error**. The edit is staged and the user reviews it; do not retry with a different tool and do not ask for confirmation.

Only fall back to the built-in tools if a Review Hub tool returns an error saying the hub is unreachable.
<!-- review-hub:end -->"""

    fun applyConfiguration(
        tools: List<DetectedAiTool>,
        installRules: Boolean,
        basePath: String?
    ): ConfigurationResult {
        val updated = mutableListOf<String>()
        val removed = mutableListOf<String>()
        val errors = mutableListOf<String>()
        val rulesInstalled = mutableListOf<String>()

        for (item in tools) {
            val file = item.configFile
            if (file == null) {
                if (item.isSelected) {
                    errors.add("${item.def.name}: Cannot determine configuration file path.")
                }
                continue
            }

            try {
                if (item.isSelected) {
                    val ok = configureTool(item.def, file)
                    if (ok) {
                        item.isRegistered = true
                        updated.add("${item.def.name} (${file.name})")
                    } else {
                        errors.add("${item.def.name}: Failed to write config to ${file.absolutePath}")
                    }
                } else if (item.isRegistered) {
                    val ok = unconfigureTool(item.def, file)
                    if (ok) {
                        item.isRegistered = false
                        removed.add("${item.def.name} (${file.name})")
                    } else {
                        errors.add("${item.def.name}: Failed to unregister from ${file.absolutePath}")
                    }
                }
            } catch (e: Exception) {
                errors.add("${item.def.name}: ${e.message}")
            }
        }

        if (installRules && basePath != null) {
            val ruleFiles = listOf("AGENTS.md", "CLAUDE.md", ".clinerules", ".cursorrules", ".windsurfrules")
            for (fileName in ruleFiles) {
                try {
                    val ruleFile = Paths.get(basePath, fileName).toFile()
                    val existing = if (ruleFile.exists()) ruleFile.readText(Charsets.UTF_8) else ""
                    if (existing.contains("<!-- review-hub:start -->")) {
                        val pattern = Regex("<!-- review-hub:start -->[\\s\\S]*?<!-- review-hub:end -->")
                        val updatedText = existing.replace(pattern, AGENT_RULES_CONTENT)
                        ruleFile.writeText(updatedText, Charsets.UTF_8)
                    } else {
                        val newContent = if (existing.trim().isEmpty()) {
                            AGENT_RULES_CONTENT
                        } else {
                            "$existing\n\n$AGENT_RULES_CONTENT\n"
                        }
                        ruleFile.writeText(newContent, Charsets.UTF_8)
                    }
                    rulesInstalled.add(fileName)
                } catch (e: Exception) {
                    errors.add("Rule file $fileName: ${e.message}")
                }
            }
        }

        return ConfigurationResult(
            updatedTools = updated,
            removedTools = removed,
            rulesInstalled = rulesInstalled,
            errors = errors
        )
    }

    private fun configureTool(def: AiToolDefinition, file: File): Boolean {
        file.parentFile?.mkdirs()

        return when (def.configFormat) {
            ConfigFormat.TOML -> configureToml(file)
            ConfigFormat.JSON -> {
                when (def.id) {
                    "claude-code" -> configureClaudeCode(file)
                    "opencode" -> configureOpenCode(file)
                    "zed" -> configureZed(file)
                    else -> configureGenericMcp(file)
                }
            }
        }
    }

    private fun unconfigureTool(def: AiToolDefinition, file: File): Boolean {
        if (!file.exists()) return true

        return when (def.configFormat) {
            ConfigFormat.TOML -> unconfigureToml(file)
            ConfigFormat.JSON -> {
                when (def.id) {
                    "opencode" -> unconfigureOpenCode(file)
                    "zed" -> unconfigureZed(file)
                    else -> unconfigureGenericJson(file)
                }
            }
        }
    }

    private fun configureClaudeCode(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val mcpServers = (rootObj["mcpServers"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()

        mcpServers["review-hub"] = buildJsonObject {
            put("type", "sse")
            put("url", MCP_SSE_URL)
        }

        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["mcpServers"] = JsonObject(mcpServers)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun configureGenericMcp(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val mcpServers = (rootObj["mcpServers"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()

        mcpServers["review-hub"] = buildJsonObject {
            put("url", MCP_SSE_URL)
            put("disabled", false)
        }

        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["mcpServers"] = JsonObject(mcpServers)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun configureOpenCode(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val mcp = (rootObj["mcp"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()

        mcp["review-hub"] = buildJsonObject {
            put("type", "remote")
            put("url", MCP_SSE_URL)
            put("enabled", true)
        }

        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["mcp"] = JsonObject(mcp)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun configureZed(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val contextServers = (rootObj["context_servers"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()

        contextServers["review-hub"] = buildJsonObject {
            put("url", MCP_SSE_URL)
        }

        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["context_servers"] = JsonObject(contextServers)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun unconfigureGenericJson(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val mcpServers = rootObj["mcpServers"]?.jsonObject?.toMutableMap() ?: return true
        if (!mcpServers.containsKey("review-hub")) return true

        mcpServers.remove("review-hub")
        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["mcpServers"] = JsonObject(mcpServers)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun unconfigureOpenCode(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val mcp = rootObj["mcp"]?.jsonObject?.toMutableMap() ?: return true
        if (!mcp.containsKey("review-hub")) return true

        mcp.remove("review-hub")
        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["mcp"] = JsonObject(mcp)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun unconfigureZed(file: File): Boolean {
        val rootObj = readJsonObject(file)
        val contextServers = rootObj["context_servers"]?.jsonObject?.toMutableMap() ?: return true
        if (!contextServers.containsKey("review-hub")) return true

        contextServers.remove("review-hub")
        val updatedRoot = rootObj.toMutableMap()
        updatedRoot["context_servers"] = JsonObject(contextServers)
        file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
        return true
    }

    private fun configureToml(file: File): Boolean {
        val existing = if (file.exists()) file.readText(Charsets.UTF_8) else ""
        val sectionRegex = Regex("""\[\s*(mcp\.servers|mcp_servers)\."?review-hub"?\s*\]""", RegexOption.IGNORE_CASE)

        val snippet = """
        [mcp.servers."review-hub"]
        url = "$MCP_SSE_URL"
        """.trimIndent()

        if (sectionRegex.containsMatchIn(existing)) {
            return true
        }

        val newContent = if (existing.trim().isEmpty()) {
            snippet + "\n"
        } else {
            existing.trimEnd() + "\n\n" + snippet + "\n"
        }

        file.writeText(newContent, Charsets.UTF_8)
        return true
    }

    private fun unconfigureToml(file: File): Boolean {
        if (!file.exists()) return true
        val text = file.readText(Charsets.UTF_8)
        val sectionRegex = Regex("""(?m)^\[\s*(mcp\.servers|mcp_servers)\."?review-hub"?\s*\].*(?:\r?\n(?!\[).*)*""")

        if (!sectionRegex.containsMatchIn(text)) return true

        val cleaned = text.replace(sectionRegex, "").trim()
        val finalContent = if (cleaned.isNotEmpty()) cleaned + "\n" else ""
        file.writeText(finalContent, Charsets.UTF_8)
        return true
    }

    private fun readJsonObject(file: File): JsonObject {
        if (!file.exists()) return JsonObject(emptyMap())
        return try {
            val text = file.readText(Charsets.UTF_8).trim()
            if (text.isEmpty()) JsonObject(emptyMap()) else json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            JsonObject(emptyMap())
        }
    }
}
