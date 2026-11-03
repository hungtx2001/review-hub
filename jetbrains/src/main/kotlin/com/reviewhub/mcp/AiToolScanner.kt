package com.reviewhub.mcp

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Paths

object AiToolScanner {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; prettyPrint = true }
    private const val CUSTOM_TOOLS_KEY = "com.reviewhub.custom_ai_tools"

    val supportedTools: List<AiToolDefinition> get() = getAllTools()

    fun isCommandOnPath(command: String): Boolean {
        val pathEnv = System.getenv("PATH") ?: return false
        val isWindows = System.getProperty("os.name")?.lowercase()?.contains("win") == true
        val extensions = if (isWindows) listOf(".exe", ".cmd", ".bat", "") else listOf("")

        for (dir in pathEnv.split(File.pathSeparator)) {
            val trimmed = dir.trim()
            if (trimmed.isEmpty()) continue
            for (ext in extensions) {
                val file = File(trimmed, command + ext)
                if (file.exists() && (isWindows || file.canExecute())) {
                    return true
                }
            }
        }
        return false
    }

    val builtInTools: List<AiToolDefinition> = listOf(
        AiToolDefinition(
            id = "codex-cli",
            name = "OpenAI Codex CLI",
            description = "OpenAI Codex CLI harness (~/.codex/config.toml)",
            cliCommand = "codex",
            configFormat = ConfigFormat.TOML,
            resolveConfigFile = { home, basePath ->
                val projectToml = basePath?.let { Paths.get(it, ".codex", "config.toml").toFile() }
                if (projectToml != null && (projectToml.exists() || Paths.get(basePath, ".codex").toFile().exists())) {
                    projectToml
                } else {
                    Paths.get(home, ".codex", "config.toml").toFile()
                }
            },
            checkInstalled = { home, basePath ->
                isCommandOnPath("codex") ||
                        Paths.get(home, ".codex").toFile().exists() ||
                        (basePath != null && Paths.get(basePath, ".codex").toFile().exists())
            }
        ),
        AiToolDefinition(
            id = "claude-code",
            name = "Claude Code CLI",
            description = "Anthropic Claude Code CLI harness (~/.claude.json)",
            cliCommand = "claude",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                Paths.get(home, ".claude.json").toFile()
            },
            checkInstalled = { home, _ ->
                isCommandOnPath("claude") ||
                        Paths.get(home, ".claude.json").toFile().exists() ||
                        Paths.get(home, ".claude").toFile().exists()
            }
        ),
        AiToolDefinition(
            id = "cursor",
            name = "Cursor IDE",
            description = "Cursor AI Editor (~/.cursor/mcp.json or project .cursor/mcp.json)",
            cliCommand = "cursor",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, basePath ->
                val projectConfig = basePath?.let { Paths.get(it, ".cursor", "mcp.json").toFile() }
                if (projectConfig != null && (projectConfig.exists() || Paths.get(basePath, ".cursor").toFile().exists())) {
                    projectConfig
                } else {
                    Paths.get(home, ".cursor", "mcp.json").toFile()
                }
            },
            checkInstalled = { home, basePath ->
                isCommandOnPath("cursor") ||
                        Paths.get(home, ".cursor").toFile().exists() ||
                        (basePath != null && Paths.get(basePath, ".cursor").toFile().exists())
            }
        ),
        AiToolDefinition(
            id = "windsurf",
            name = "Windsurf IDE",
            description = "Windsurf / Cascade AI Editor MCP config",
            cliCommand = "windsurf",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    Paths.get(home, ".codeium", "windsurf", "mcp_config.json").toFile(),
                    System.getenv("APPDATA")?.let { Paths.get(it, "devin", "mcp_config.json").toFile() },
                    Paths.get(home, ".config", "devin", "mcp_config.json").toFile(),
                    Paths.get(home, "Library", "Application Support", "devin", "mcp_config.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.first()
            },
            checkInstalled = { home, _ ->
                isCommandOnPath("windsurf") ||
                        Paths.get(home, ".codeium", "windsurf").toFile().exists() ||
                        System.getenv("APPDATA")?.let { Paths.get(it, "devin").toFile().exists() } == true ||
                        Paths.get(home, ".config", "devin").toFile().exists()
            }
        ),
        AiToolDefinition(
            id = "roo-code",
            name = "Roo Code",
            description = "Roo Code extension MCP settings (VS Code / JetBrains)",
            cliCommand = null,
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile() },
                    Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile(),
                    Paths.get(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile(),
                    Paths.get(home, ".vscode-server", "data", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.firstOrNull()
            },
            checkInstalled = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline").toFile() },
                    Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline").toFile(),
                    Paths.get(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline").toFile()
                )
                candidates.any { it.exists() }
            }
        ),
        AiToolDefinition(
            id = "cline",
            name = "Cline",
            description = "Cline extension MCP settings (VS Code / JetBrains)",
            cliCommand = null,
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile() },
                    Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile(),
                    Paths.get(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json").toFile(),
                    Paths.get(home, ".cline", "data", "settings", "cline_mcp_settings.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.firstOrNull()
            },
            checkInstalled = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Code", "User", "globalStorage", "saoudrizwan.claude-dev").toFile() },
                    Paths.get(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev").toFile(),
                    Paths.get(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev").toFile(),
                    Paths.get(home, ".cline").toFile()
                )
                candidates.any { it.exists() }
            }
        ),
        AiToolDefinition(
            id = "opencode",
            name = "OpenCode CLI",
            description = "OpenCode CLI (~/.config/opencode/opencode.json)",
            cliCommand = "opencode",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, basePath ->
                val projectConfig = basePath?.let { Paths.get(it, ".opencode", "opencode.json").toFile() }
                if (projectConfig != null && (projectConfig.exists() || Paths.get(basePath, ".opencode").toFile().exists())) {
                    projectConfig
                } else {
                    Paths.get(home, ".config", "opencode", "opencode.json").toFile()
                }
            },
            checkInstalled = { home, basePath ->
                isCommandOnPath("opencode") ||
                        Paths.get(home, ".config", "opencode").toFile().exists() ||
                        (basePath != null && Paths.get(basePath, ".opencode").toFile().exists())
            }
        ),
        AiToolDefinition(
            id = "zed",
            name = "Zed Editor",
            description = "Zed context_servers MCP configuration (~/.config/zed/settings.json)",
            cliCommand = "zed",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Zed", "settings.json").toFile() },
                    Paths.get(home, "Library", "Application Support", "Zed", "settings.json").toFile(),
                    Paths.get(home, ".config", "zed", "settings.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.first()
            },
            checkInstalled = { home, _ ->
                isCommandOnPath("zed") ||
                        Paths.get(home, ".config", "zed").toFile().exists() ||
                        Paths.get(home, "Library", "Application Support", "Zed").toFile().exists() ||
                        System.getenv("APPDATA")?.let { Paths.get(it, "Zed").toFile().exists() } == true
            }
        ),
        AiToolDefinition(
            id = "continue",
            name = "Continue.dev",
            description = "Continue AI coding assistant (~/.continue/config.json)",
            cliCommand = null,
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                Paths.get(home, ".continue", "config.json").toFile()
            },
            checkInstalled = { home, _ ->
                Paths.get(home, ".continue").toFile().exists()
            }
        ),
        AiToolDefinition(
            id = "gemini-cli",
            name = "Gemini / Antigravity CLI",
            description = "Gemini CLI / Antigravity harness settings",
            cliCommand = "gemini",
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    Paths.get(home, ".gemini", "antigravity", "mcp_config.json").toFile(),
                    Paths.get(home, ".gemini", "settings.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.first()
            },
            checkInstalled = { home, _ ->
                isCommandOnPath("gemini") || Paths.get(home, ".gemini").toFile().exists()
            }
        ),
        AiToolDefinition(
            id = "claude-desktop",
            name = "Claude Desktop",
            description = "Claude Desktop client MCP config",
            cliCommand = null,
            configFormat = ConfigFormat.JSON,
            resolveConfigFile = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Claude", "claude_desktop_config.json").toFile() },
                    Paths.get(home, "Library", "Application Support", "Claude", "claude_desktop_config.json").toFile(),
                    Paths.get(home, ".config", "Claude", "claude_desktop_config.json").toFile()
                )
                candidates.firstOrNull { it.exists() } ?: candidates.firstOrNull()
            },
            checkInstalled = { home, _ ->
                val candidates = listOfNotNull(
                    System.getenv("APPDATA")?.let { Paths.get(it, "Claude").toFile() },
                    Paths.get(home, "Library", "Application Support", "Claude").toFile(),
                    Paths.get(home, ".config", "Claude").toFile()
                )
                candidates.any { it.exists() }
            }
        )
    )

    fun getCustomTools(): List<CustomToolConfig> {
        return try {
            val app = ApplicationManager.getApplication() ?: return emptyList()
            val raw = PropertiesComponent.getInstance().getValue(CUSTOM_TOOLS_KEY) ?: return emptyList()
            json.decodeFromString<List<CustomToolConfig>>(raw)
        } catch (_: Throwable) {
            emptyList()
        }
    }

    fun saveCustomTool(tool: CustomToolConfig) {
        try {
            val existing = getCustomTools().filter { it.id != tool.id }.toMutableList()
            existing.add(tool)
            val app = ApplicationManager.getApplication()
            if (app != null) {
                PropertiesComponent.getInstance().setValue(CUSTOM_TOOLS_KEY, json.encodeToString(existing))
            }
        } catch (_: Throwable) {}
    }

    fun removeCustomTool(id: String) {
        try {
            val existing = getCustomTools().filter { it.id != id }
            val app = ApplicationManager.getApplication()
            if (app != null) {
                PropertiesComponent.getInstance().setValue(CUSTOM_TOOLS_KEY, json.encodeToString(existing))
            }
        } catch (_: Throwable) {}
    }

    fun getAllTools(): List<AiToolDefinition> {
        val customDefs = getCustomTools().map { custom ->
            AiToolDefinition(
                id = custom.id,
                name = custom.name,
                description = "Custom tool config: ${custom.filePath}",
                cliCommand = null,
                configFormat = if (custom.format.equals("TOML", ignoreCase = true)) ConfigFormat.TOML else ConfigFormat.JSON,
                isCustom = true,
                resolveConfigFile = { _, _ -> File(custom.filePath) },
                checkInstalled = { _, _ -> File(custom.filePath).exists() }
            )
        }
        return builtInTools + customDefs
    }

    fun scan(basePath: String?): List<DetectedAiTool> {
        val home = System.getProperty("user.home") ?: ""
        val results = mutableListOf<DetectedAiTool>()

        for (def in getAllTools()) {
            val file = def.resolveConfigFile(home, basePath)
            val isInstalled = def.checkInstalled(home, basePath) || (file != null && file.exists())
            val isRegistered = if (file != null && file.exists()) isToolRegistered(def, file) else false

            val statusReason = when {
                def.isCustom -> if (file?.exists() == true) "Custom (File exists)" else "Custom (File not found)"
                isRegistered -> "Configured"
                def.cliCommand != null && isCommandOnPath(def.cliCommand) -> "Detected (CLI in PATH)"
                file != null && file.exists() -> "Detected (Config exists)"
                isInstalled -> "Detected (App directory found)"
                else -> "Not Installed"
            }

            val isSelected = isRegistered || isInstalled

            results.add(
                DetectedAiTool(
                    def = def,
                    configFile = file,
                    isInstalled = isInstalled,
                    isRegistered = isRegistered,
                    isSelected = isSelected,
                    statusText = statusReason,
                    isCustom = def.isCustom
                )
            )
        }

        return results
    }

    fun isToolRegistered(def: AiToolDefinition, file: File): Boolean {
        if (!file.exists()) return false
        return try {
            val text = file.readText(Charsets.UTF_8).trim()
            if (text.isEmpty()) return false

            when (def.configFormat) {
                ConfigFormat.TOML -> {
                    val regex = Regex("""\[\s*(mcp\.servers|mcp_servers)\."?review-hub"?\s*\]""", RegexOption.IGNORE_CASE)
                    regex.containsMatchIn(text)
                }
                ConfigFormat.JSON -> {
                    val root = json.parseToJsonElement(text).jsonObject
                    when (def.id) {
                        "opencode" -> {
                            val mcp = root["mcp"]?.jsonObject
                            val rh = mcp?.get("review-hub")?.jsonObject
                            rh?.get("enabled")?.jsonPrimitive?.booleanOrNull != false && rh != null
                        }
                        "zed" -> {
                            val cs = root["context_servers"]?.jsonObject
                            cs?.containsKey("review-hub") == true
                        }
                        else -> {
                            val mcpServers = root["mcpServers"]?.jsonObject
                            val rh = mcpServers?.get("review-hub")?.jsonObject
                            rh?.get("disabled")?.jsonPrimitive?.booleanOrNull != true && rh != null
                        }
                    }
                }
            }
        } catch (_: Exception) {
            false
        }
    }
}
