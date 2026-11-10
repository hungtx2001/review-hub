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
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.wm.ToolWindowManager
import com.reviewhub.core.ChangeStore
import com.reviewhub.inline.ReviewHubInlineReview
import com.reviewhub.model.ChangeSet
import com.reviewhub.model.ChangeSummary
import com.reviewhub.model.DecideResult
import com.reviewhub.model.HubEntry
import com.reviewhub.server.ReviewHubServer
import com.reviewhub.util.PathUtil
import com.reviewhub.util.ReviewHubPaths
import kotlinx.serialization.json.Json
import java.io.File
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CopyOnWriteArrayList

@Service(Service.Level.PROJECT)
class HubManager(private val project: Project) : Disposable {
    private val logger = Logger.getInstance(HubManager::class.java)

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    val store: ChangeStore = ChangeStore()
    private var embeddedServer: ReviewHubServer? = null

    val isLocalStore: Boolean
        get() = embeddedServer != null

    var client: HubClient? = null
        private set

    var changes: List<ChangeSummary> = emptyList()
        private set

    private var lastHubJsonTime: Long = 0L
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var pollingTimer: Timer? = null

    init {
        setupStoreListener()
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!project.isDisposed) {
                initEmbeddedServerAndConnect()
            }
        }
        startPolling()
    }

    private fun initEmbeddedServerAndConnect() {
        // 1. First, check if another Review Hub instance is already running
        val existingEntry = readHubEntry()
        if (existingEntry != null) {
            val candidate = HubClient(existingEntry.url, existingEntry.token)
            if (candidate.healthCheck()) {
                client = candidate
                logger.info("Connected to existing Review Hub server at ${existingEntry.url}")
                refresh()
                return
            }
        }

        // 2. Start our native embedded Kotlin MCP & HTTP server
        try {
            val server = ReviewHubServer(store, preferredPort = 49182, workspacePath = project.basePath)
            val port = server.start()
            embeddedServer = server
            client = HubClient("http://127.0.0.1:$port", server.token)
            logger.info("Started native embedded Review Hub MCP server on port $port")
            refresh()
        } catch (e: Exception) {
            logger.warn("Failed to start embedded Review Hub server", e)
        }
    }

    private fun setupStoreListener() {
        store.addChangeListener { ws, relPath ->
            ApplicationManager.getApplication().executeOnPooledThread {
                if (!project.isDisposed) {
                    if (relPath.isNotEmpty()) {
                        val ioFile = File(ws, relPath)
                        val lfs = LocalFileSystem.getInstance()
                        if (ioFile.exists()) {
                            lfs.refreshAndFindFileByIoFile(ioFile)?.refresh(true, false)
                        } else {
                            ioFile.parentFile?.let { parent ->
                                lfs.refreshAndFindFileByIoFile(parent)?.refresh(true, true)
                            }
                        }
                    } else {
                        VirtualFileManager.getInstance().asyncRefresh(null)
                    }
                    refresh()
                }
            }
        }
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
            }, 2000, 3000)
        }
    }

    fun connect(): Boolean {
        if (embeddedServer != null && client != null && client!!.healthCheck()) {
            return true
        }

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

        if (embeddedServer == null) {
            try {
                val server = ReviewHubServer(store, preferredPort = 49182, workspacePath = project.basePath)
                val port = server.start()
                embeddedServer = server
                client = HubClient("http://127.0.0.1:$port", server.token)
                logger.info("Started fallback embedded Review Hub MCP server on port $port")
                refresh()
                return true
            } catch (e: Exception) {
                logger.warn("Failed to start fallback embedded Review Hub server", e)
            }
        }

        return false
    }

    fun refresh() {
        val workspace = project.basePath ?: return
        try {
            val newChanges = if (isLocalStore) {
                store.listChanges(workspace)
            } else {
                val c = client ?: return
                c.listChanges(workspace)
            }
            if (newChanges != changes) {
                val previousPendingPaths = changes.filter { it.status != "resolved" }.map { it.path }.toSet()
                changes = newChanges
                val currentPending = changes.filter { it.status != "resolved" }
                val newlyAddedPending = currentPending.filter { it.path !in previousPendingPaths }

                notifyListeners()
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        FileStatusManager.getInstance(project).fileStatusesChanged()
                        ProjectView.getInstance(project).refresh()

                        // Update tool window badge
                        val toolWindowManager = ToolWindowManager.getInstance(project)
                        val toolWindow = toolWindowManager.getToolWindow("Review Hub")
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
            val c = client
            if (!isLocalStore && c != null && !c.healthCheck()) {
                client = null
                notifyListeners()
            }
        }
    }

    fun getChangeSet(changeId: String, workspace: String? = project.basePath): ChangeSet? {
        return if (isLocalStore) {
            store.getChange(changeId, workspace)
        } else {
            client?.getChange(changeId, workspace)
        }
    }

    fun acceptChange(
        changeId: String? = null,
        workspace: String? = project.basePath,
        path: String? = null,
        hunkIds: List<String>? = null,
        customContent: String? = null
    ): DecideResult? {
        return if (isLocalStore) {
            val res = store.accept(changeId, workspace, path, hunkIds, customContent)
            refresh()
            res
        } else {
            val res = client?.accept(changeId, workspace, path, hunkIds, customContent)
            refresh()
            res
        }
    }

    fun rejectChange(
        changeId: String? = null,
        workspace: String? = project.basePath,
        path: String? = null,
        hunkIds: List<String>? = null
    ): DecideResult? {
        return if (isLocalStore) {
            val res = store.reject(changeId, workspace, path, hunkIds)
            refresh()
            res
        } else {
            val res = client?.reject(changeId, workspace, path, hunkIds)
            refresh()
            res
        }
    }

    fun acceptAll() {
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            acceptChange(workspace = workspace)
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) {
                    ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                    VirtualFileManager.getInstance().asyncRefresh(null)
                }
            }
        }
    }

    fun rejectAll() {
        val workspace = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            rejectChange(workspace = workspace)
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) {
                    ReviewHubInlineReview.reloadAllOpenReviewEditors(project)
                    VirtualFileManager.getInstance().asyncRefresh(null)
                }
            }
        }
    }

    fun findChange(relPath: String): ChangeSummary? {
        return changes.find {
            PathUtil.pathsMatch(it.path, relPath) && it.status != "resolved"
        }
    }

    fun isPending(path: String): Boolean {
        return findChange(path) != null
    }

    private fun getHubJsonFile(): File? {
        val hubJson = ReviewHubPaths.getHubJsonFile()
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

    override fun dispose() {
        pollingTimer?.cancel()
        pollingTimer = null
        listeners.clear()
        embeddedServer?.stop()
        embeddedServer = null
        client = null
    }
}
