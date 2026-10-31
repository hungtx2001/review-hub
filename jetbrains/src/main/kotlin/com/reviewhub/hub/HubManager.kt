package com.reviewhub.hub

import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FileStatusManager
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.EditorNotifications
import com.reviewhub.inline.ReviewHubInlineReview
import com.reviewhub.model.ChangeSummary
import com.reviewhub.model.HubEntry
import com.reviewhub.util.PathUtil
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Paths
import java.util.Timer
import java.util.TimerTask

@Service(Service.Level.PROJECT)
class HubManager(private val project: Project) : Disposable {
    private val logger = Logger.getInstance(HubManager::class.java)

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    var client: HubClient? = null
        private set

    var changes: List<ChangeSummary> = emptyList()
        private set

    private var lastHubJsonTime: Long = 0L
    private val listeners = mutableListOf<() -> Unit>()
    private var pollingTimer: Timer? = null

    init {
        connect()
        startPolling()
    }

    fun addChangeListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeChangeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyListeners() {
        listeners.forEach {
            try {
                it.invoke()
            } catch (e: Exception) {
                logger.warn("Error in change listener", e)
            }
        }
    }

    private fun startPolling() {
        pollingTimer?.cancel()
        pollingTimer = Timer("ReviewHubPolling", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (project.isDisposed) {
                        cancel()
                        return
                    }

                    // Check if hub.json has been updated or server restarted
                    val hubFile = getHubJsonFile()
                    val currentMtime = hubFile?.lastModified() ?: 0L
                    val hubUpdated = hubFile != null && currentMtime > lastHubJsonTime

                    if (client == null || hubUpdated) {
                        connect()
                    } else {
                        refresh()
                    }
                }
            }, 1000, 2500)
        }
    }

    fun connect(): Boolean {
        val entry = readHubEntry()
        if (entry != null) {
            val candidate = HubClient(entry.url, entry.token)
            if (candidate.healthCheck()) {
                client = candidate
                logger.info("Connected to Review Hub at ${entry.url}")
                refresh()
                return true
            }
        }

        // If not running, attempt to spawn standalone hub daemon
        val spawned = trySpawnHub()
        if (spawned) {
            Thread.sleep(1000)
            val newEntry = readHubEntry()
            if (newEntry != null) {
                val candidate = HubClient(newEntry.url, newEntry.token)
                if (candidate.healthCheck()) {
                    client = candidate
                    logger.info("Successfully launched and connected to Review Hub at ${newEntry.url}")
                    refresh()
                    return true
                }
            }
        }

        logger.debug("Review Hub server is not running yet.")
        return false
    }

    fun refresh() {
        val c = client ?: return
        val workspace = project.basePath ?: return
        try {
            val newChanges = c.listChanges(workspace)
            if (newChanges != changes) {
                val previousPendingPaths = changes.filter { it.status == "pending" }.map { it.path }.toSet()
                changes = newChanges
                val currentPending = changes.filter { it.status == "pending" }
                val newlyAddedPending = currentPending.filter { it.path !in previousPendingPaths }

                notifyListeners()
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        FileStatusManager.getInstance(project).fileStatusesChanged()
                        ProjectView.getInstance(project).refresh()
                        VirtualFileManager.getInstance().asyncRefresh(null)

                        // ToolWindow management: show ToolWindow & update badge
                        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Review Hub")
                        if (toolWindow != null) {
                            if (currentPending.isNotEmpty()) {
                                toolWindow.stripeTitle = "Review Hub (${currentPending.size})"
                                if (newlyAddedPending.isNotEmpty() && !toolWindow.isVisible) {
                                    toolWindow.show()
                                }
                            } else {
                                toolWindow.stripeTitle = "Review Hub"
                            }
                        }

                        // Update inlays in all open editors
                        val fileEditorManager = FileEditorManager.getInstance(project)
                        for (editor in fileEditorManager.allEditors) {
                            if (editor is TextEditor) {
                                val vf = editor.file
                                if (vf != null) {
                                    val rPath = PathUtil.toRelativePath(project, vf)
                                    if (rPath != null) {
                                        ReviewHubInlineReview.updateInlays(project, editor.editor, rPath)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            logger.debug("Failed to refresh changes from Review Hub", e)
            // If connection failed, test health; if dead, reset client to trigger reconnect
            if (!c.healthCheck()) {
                client = null
                notifyListeners()
            }
        }
    }

    fun acceptAll() {
        val c = client ?: return
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            c.accept(workspace = workspace)
            refresh()
        }
    }

    fun rejectAll() {
        val c = client ?: return
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            c.reject(workspace = workspace)
            refresh()
        }
    }

    fun findChange(relPath: String): ChangeSummary? {
        return changes.find {
            PathUtil.pathsMatch(it.path, relPath) && it.status == "pending"
        }
    }

    fun isPending(path: String): Boolean {
        return findChange(path) != null
    }

    private fun getHubJsonFile(): File? {
        val home = System.getProperty("user.home") ?: return null
        val hubJson = Paths.get(home, ".review-hub", "hub.json").toFile()
        return if (hubJson.exists()) hubJson else null
    }

    private fun readHubEntry(): HubEntry? {
        val hubJson = getHubJsonFile() ?: return null
        return try {
            lastHubJsonTime = hubJson.lastModified()
            json.decodeFromString<HubEntry>(hubJson.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            logger.warn("Failed to parse hub.json", e)
            null
        }
    }

    private fun ensureExtractedHubServer(): File? {
        val home = System.getProperty("user.home") ?: return null
        val target = Paths.get(home, ".review-hub", "bin", "hub-server.cjs").toFile()
        if (target.exists() && target.length() > 0) {
            return target
        }
        val stream = javaClass.getResourceAsStream("/server/hub-server.cjs") ?: return null
        return try {
            target.parentFile?.mkdirs()
            target.outputStream().use { out ->
                stream.copyTo(out)
            }
            target
        } catch (e: Exception) {
            logger.warn("Could not extract bundled hub-server.cjs", e)
            null
        }
    }

    private fun trySpawnHub(): Boolean {
        val workspace = project.basePath ?: return false
        val home = System.getProperty("user.home")

        val extracted = ensureExtractedHubServer()

        val candidates = listOfNotNull(
            extracted,
            File(workspace, "dist/hub-server.cjs"),
            File(workspace, "../dist/hub-server.cjs"),
            File(workspace, "../hub-preview/dist/hub-server.cjs"),
            home?.let { File(it, ".review-hub/bin/hub-server.cjs") },
            home?.let { File(it, ".review-hub/dist/hub-server.cjs") },
            home?.let { File(it, ".review-hub/hub-server.cjs") }
        )

        val targetScript = candidates.firstOrNull { it.exists() } ?: return false

        return try {
            val pb = ProcessBuilder("node", targetScript.absolutePath, workspace)
            pb.directory(File(workspace))
            pb.redirectErrorStream(true)
            pb.start()
            true
        } catch (e: Exception) {
            logger.warn("Failed to spawn node hub-server.cjs", e)
            false
        }
    }

    override fun dispose() {
        pollingTimer?.cancel()
        pollingTimer = null
        listeners.clear()
    }
}
