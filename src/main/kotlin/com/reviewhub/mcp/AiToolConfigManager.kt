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

    /**
     * Agent rules injected into AGENTS.md / CLAUDE.md / etc.
     * Single source of truth: the repo-root AGENTS.md (bundled as /rules/AGENTS.md by Gradle).
     * Only the <!-- review-hub:start --> ... <!-- review-hub:end --> block is used.
     */
    val AGENT_RULES_CONTENT: String by lazy {
        val raw = AiToolConfigManager::class.java.getResourceAsStream("/rules/AGENTS.md")
            ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            ?: error("Missing bundled resource /rules/AGENTS.md")
        Regex("<!-- review-hub:start -->[\\s\\S]*?<!-- review-hub:end -->").find(raw)?.value
            ?: error("AGENTS.md has no review-hub:start/end block")
    }

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
            val selectedIds = tools.filter { it.isSelected }.map { it.def.id }.toSet()
            val ruleFiles = buildList {
                add("AGENTS.md")
                if ("claude-code" in selectedIds || Paths.get(basePath, "CLAUDE.md").toFile().exists()) add("CLAUDE.md")
                if ("cline" in selectedIds || "roo-code" in selectedIds || Paths.get(basePath, ".clinerules").toFile().exists()) add(".clinerules")
                if (Paths.get(basePath, ".cursorrules").toFile().exists()) add(".cursorrules")
                if (Paths.get(basePath, ".windsurfrules").toFile().exists()) add(".windsurfrules")
            }
            for (fileName in ruleFiles) {
                try {
                    val ruleFile = Paths.get(basePath, fileName).toFile()
                    val existing = if (ruleFile.exists()) ruleFile.readText(Charsets.UTF_8) else ""
                    if (existing.contains("<!-- review-hub:start -->")) {
                        val pattern = Regex("<!-- review-hub:start -->[\\s\\S]*?<!-- review-hub:end -->")
                        val updatedText = existing.replace(pattern) { AGENT_RULES_CONTENT }
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
