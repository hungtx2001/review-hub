package com.reviewhub.mcp

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AiToolConfigTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testConfigureAndUnconfigureToml() {
        val codexDef = AiToolScanner.supportedTools.first { it.id == "codex-cli" }
        val tomlFile = tempFolder.newFile("config.toml")

        // Initial content
        tomlFile.writeText("""
        model = "gpt-4o"
        [some_other_section]
        key = "value"
        """.trimIndent())

        val tool = DetectedAiTool(
            def = codexDef,
            configFile = tomlFile,
            isInstalled = true,
            isRegistered = false,
            isSelected = true,
            statusText = "Detected"
        )

        // 1. Apply configuration (Enable)
        val result1 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result1.errors.isEmpty())
        assertEquals(1, result1.updatedTools.size)
        assertTrue(tool.isRegistered)

        val updatedToml = tomlFile.readText()
        assertTrue(updatedToml.contains("""[mcp.servers."review-hub"]"""))
        assertTrue(updatedToml.contains("49182/sse"))
        assertTrue(updatedToml.contains("some_other_section")) // Preserved existing

        // Check scanner recognizes it
        assertTrue(AiToolScanner.isToolRegistered(codexDef, tomlFile))

        // 2. Unconfigure (Disable)
        tool.isSelected = false
        val result2 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result2.errors.isEmpty())
        assertEquals(1, result2.removedTools.size)
        assertFalse(tool.isRegistered)

        val unconfiguredToml = tomlFile.readText()
        assertFalse(unconfiguredToml.contains("review-hub"))
        assertTrue(unconfiguredToml.contains("some_other_section"))
        assertFalse(AiToolScanner.isToolRegistered(codexDef, tomlFile))
    }

    @Test
    fun testConfigureAndUnconfigureClaudeCodeJson() {
        val claudeDef = AiToolScanner.supportedTools.first { it.id == "claude-code" }
        val claudeFile = tempFolder.newFile(".claude.json")

        // Initial content with existing MCP server
        claudeFile.writeText("""
        {
          "mcpServers": {
            "existing-server": {
              "command": "node",
              "args": ["server.js"]
            }
          }
        }
        """.trimIndent())

        val tool = DetectedAiTool(
            def = claudeDef,
            configFile = claudeFile,
            isInstalled = true,
            isRegistered = false,
            isSelected = true,
            statusText = "Detected"
        )

        // 1. Enable
        val result1 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result1.errors.isEmpty())
        assertEquals(1, result1.updatedTools.size)
        assertTrue(tool.isRegistered)

        val text1 = claudeFile.readText()
        assertTrue(text1.contains("review-hub"))
        assertTrue(text1.contains("existing-server"))
        assertTrue(AiToolScanner.isToolRegistered(claudeDef, claudeFile))

        // 2. Disable
        tool.isSelected = false
        val result2 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result2.errors.isEmpty())
        assertEquals(1, result2.removedTools.size)
        assertFalse(tool.isRegistered)

        val text2 = claudeFile.readText()
        assertFalse(text2.contains("review-hub"))
        assertTrue(text2.contains("existing-server"))
        assertFalse(AiToolScanner.isToolRegistered(claudeDef, claudeFile))
    }

    @Test
    fun testConfigureAndUnconfigureOpenCode() {
        val opencodeDef = AiToolScanner.supportedTools.first { it.id == "opencode" }
        val opencodeFile = tempFolder.newFile("opencode.json")

        val tool = DetectedAiTool(
            def = opencodeDef,
            configFile = opencodeFile,
            isInstalled = true,
            isRegistered = false,
            isSelected = true,
            statusText = "Detected"
        )

        val result1 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result1.errors.isEmpty())
        assertTrue(tool.isRegistered)
        assertTrue(AiToolScanner.isToolRegistered(opencodeDef, opencodeFile))

        tool.isSelected = false
        val result2 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result2.errors.isEmpty())
        assertFalse(tool.isRegistered)
        assertFalse(AiToolScanner.isToolRegistered(opencodeDef, opencodeFile))
    }

    @Test
    fun testConfigureAndUnconfigureZed() {
        val zedDef = AiToolScanner.supportedTools.first { it.id == "zed" }
        val zedFile = tempFolder.newFile("zed-settings.json")

        val tool = DetectedAiTool(
            def = zedDef,
            configFile = zedFile,
            isInstalled = true,
            isRegistered = false,
            isSelected = true,
            statusText = "Detected"
        )

        val result1 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result1.errors.isEmpty())
        assertTrue(tool.isRegistered)
        assertTrue(zedFile.readText().contains("context_servers"))
        assertTrue(AiToolScanner.isToolRegistered(zedDef, zedFile))

        tool.isSelected = false
        val result2 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result2.errors.isEmpty())
        assertFalse(tool.isRegistered)
        assertFalse(AiToolScanner.isToolRegistered(zedDef, zedFile))
    }

    @Test
    fun testCustomToolConfiguration() {
        val customFile = tempFolder.newFile("my-custom-cli.json")
        val customDef = AiToolDefinition(
            id = "custom-123",
            name = "My Custom CLI",
            description = "Custom tool",
            cliCommand = null,
            configFormat = ConfigFormat.JSON,
            isCustom = true,
            resolveConfigFile = { _, _ -> customFile },
            checkInstalled = { _, _ -> true }
        )

        val tool = DetectedAiTool(
            def = customDef,
            configFile = customFile,
            isInstalled = true,
            isRegistered = false,
            isSelected = true,
            statusText = "Custom",
            isCustom = true
        )

        val result1 = AiToolConfigManager.applyConfiguration(listOf(tool), false, null)
        assertTrue(result1.errors.isEmpty())
        assertTrue(tool.isRegistered)
        assertTrue(customFile.readText().contains("review-hub"))
    }

    @Test
    fun testInstallRules() {
        val projectDir = tempFolder.newFolder("my-project")
        val agentsFile = File(projectDir, "AGENTS.md")
        agentsFile.writeText("# Existing project instructions\n")

        val result = AiToolConfigManager.applyConfiguration(
            tools = emptyList(),
            installRules = true,
            basePath = projectDir.absolutePath
        )

        assertTrue(result.errors.isEmpty())
        assertEquals(listOf("AGENTS.md"), result.rulesInstalled)

        val content = agentsFile.readText()
        assertTrue(content.contains("# Existing project instructions"))
        assertTrue(content.contains("<!-- review-hub:start -->"))
        assertTrue(content.contains("propose_edit"))
    }
}
