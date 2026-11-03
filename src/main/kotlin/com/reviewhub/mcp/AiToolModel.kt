package com.reviewhub.mcp

import kotlinx.serialization.Serializable
import java.io.File

enum class ConfigFormat {
    JSON,
    TOML
}

data class AiToolDefinition(
    val id: String,
    val name: String,
    val description: String,
    val cliCommand: String?,
    val configFormat: ConfigFormat,
    val isCustom: Boolean = false,
    val resolveConfigFile: (home: String, basePath: String?) -> File?,
    val checkInstalled: (home: String, basePath: String?) -> Boolean
)

data class DetectedAiTool(
    val def: AiToolDefinition,
    val configFile: File?,
    val isInstalled: Boolean,
    var isRegistered: Boolean,
    var isSelected: Boolean,
    val statusText: String,
    val isCustom: Boolean = false
)

@Serializable
data class CustomToolConfig(
    val id: String,
    val name: String,
    val filePath: String,
    val format: String // "JSON" or "TOML"
)
