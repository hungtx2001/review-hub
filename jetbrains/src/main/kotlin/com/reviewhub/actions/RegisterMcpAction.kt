package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Paths

class RegisterMcpAction : AnAction("Register MCP in AI Harnesses") {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    override fun actionPerformed(e: AnActionEvent) {
        val home = System.getProperty("user.home") ?: return
        val results = mutableListOf<String>()

        // 1. Claude Code (~/.claude.json)
        val claudeFile = Paths.get(home, ".claude.json").toFile()
        if (registerInClaude(claudeFile)) {
            results.add("Claude Code (${claudeFile.name})")
        }

        // 2. Roo Code
        val rooFile = findRooSettings(home)
        if (rooFile != null && rooFile.exists()) {
            if (registerInGenericMcp(rooFile)) {
                results.add("Roo Code (${rooFile.name})")
            }
        }

        // 3. Cline
        val clineFile = findClineSettings(home)
        if (clineFile != null && clineFile.exists()) {
            if (registerInGenericMcp(clineFile)) {
                results.add("Cline (${clineFile.name})")
            }
        }

        if (results.isEmpty()) {
            Messages.showInfoMessage(
                e.project,
                "No supported AI harness config files found.\n\nYou can use 'Copy MCP Config' action to manually add Review Hub to your AI tool.",
                "Review Hub MCP"
            )
        } else {
            val listStr = results.joinToString("\n• ", prefix = "• ")
            Messages.showInfoMessage(
                e.project,
                "Successfully registered Review Hub MCP into:\n$listStr\n\nRestart your AI tools to pick up Review Hub!",
                "Review Hub MCP Registered"
            )
        }
    }

    private fun registerInClaude(file: File): Boolean {
        return try {
            val rootObj = if (file.exists()) {
                val text = file.readText(Charsets.UTF_8).trim()
                if (text.isNotEmpty()) json.parseToJsonElement(text).jsonObject else JsonObject(emptyMap())
            } else {
                JsonObject(emptyMap())
            }

            val mcpServers = (rootObj["mcpServers"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()
            mcpServers["review-hub"] = buildJsonObject {
                put("type", "stdio")
                put("command", "npx")
                putJsonArray("args") {
                    add("-y")
                    add("review-hub-mcp")
                }
            }

            val updatedRoot = rootObj.toMutableMap()
            updatedRoot["mcpServers"] = JsonObject(mcpServers)

            file.parentFile?.mkdirs()
            file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun registerInGenericMcp(file: File): Boolean {
        return try {
            val text = file.readText(Charsets.UTF_8).trim()
            val rootObj = if (text.isNotEmpty()) json.parseToJsonElement(text).jsonObject else JsonObject(emptyMap())

            val mcpServers = (rootObj["mcpServers"]?.jsonObject ?: JsonObject(emptyMap())).toMutableMap()
            mcpServers["review-hub"] = buildJsonObject {
                put("command", "npx")
                putJsonArray("args") {
                    add("-y")
                    add("review-hub-mcp")
                }
                put("disabled", false)
            }

            val updatedRoot = rootObj.toMutableMap()
            updatedRoot["mcpServers"] = JsonObject(mcpServers)

            file.writeText(json.encodeToString(JsonObject(updatedRoot)), Charsets.UTF_8)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun findRooSettings(home: String): File? {
        val candidates = listOfNotNull(
            Paths.get(home, ".vscode-server", "data", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile(),
            System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile() },
            Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile(),
            Paths.get(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile()
        )
        return candidates.firstOrNull { it.exists() }
    }

    private fun findClineSettings(home: String): File? {
        val candidates = listOfNotNull(
            Paths.get(home, ".cline", "data", "settings", "cline_mcp_settings.json").toFile(),
            System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile() },
            Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile(),
            Paths.get(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile()
        )
        return candidates.firstOrNull { it.exists() }
    }
}
