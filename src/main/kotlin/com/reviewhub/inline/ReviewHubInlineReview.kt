package com.reviewhub.inline

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.markup.*
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.ui.JBColor
import com.reviewhub.diff.ReviewHubDiffViewer
import com.reviewhub.hub.HubManager
import com.reviewhub.model.Hunk
import java.awt.*
import java.io.File
import java.util.Collections

object ReviewHubInlineReview {
    private val HIGHLIGHTERS_KEY = Key.create<MutableList<RangeHighlighter>>("reviewhub.highlighters")
    private val INLAYS_KEY = Key.create<MutableList<Inlay<*>>>("reviewhub.inlays")
    private val STAGED_HASH_KEY = Key.create<String>("reviewhub.staged_hash")
    private val MOUSE_LISTENER_ATTACHED_KEY = Key.create<Boolean>("reviewhub.mouse_listener_attached")
    private val HUNK_LINES_KEY = Key.create<List<Int>>("reviewhub.hunk_lines")
    private val STAGED_ANCHORS_KEY = Key.create<List<StagedHunkAnchor>>("reviewhub.staged_anchors")

    private val CHANGE_ID_KEY = Key.create<String>("reviewhub.change_id")
    private val REL_PATH_KEY = Key.create<String>("reviewhub.rel_path")

    private val ACCEPT_PILL_BG = JBColor(Color(0xDA, 0xFB, 0xE1), Color(0x19, 0x3D, 0x24))
    private val REJECT_PILL_BG = JBColor(Color(0xFF, 0xE2, 0xE5), Color(0x49, 0x1D, 0x24))
    private val RED_BG = JBColor(Color(0xFF, 0xEB, 0xEC), Color(0x3D, 0x19, 0x1E))
    private val GREEN_BG = JBColor(Color(0xE6, 0xFF, 0xED), Color(0x1B, 0x38, 0x22))
    private val DELETED_TEXT_COLOR = JBColor(Color(0x82, 0x17, 0x1E), Color(0xFF, 0xA1, 0x98))

    val ACCEPT_COLOR = JBColor(Color(0x1A, 0x7F, 0x37), Color(0x56, 0xD3, 0x64))
    val ACCEPT_HOVER_COLOR = JBColor(Color(0x11, 0x63, 0x29), Color(0x7E, 0xE7, 0x87))
    val REJECT_COLOR = JBColor(Color(0xCF, 0x22, 0x2E), Color(0xF8, 0x51, 0x49))
    val REJECT_HOVER_COLOR = JBColor(Color(0xA4, 0x0E, 0x26), Color(0xFF, 0x7B, 0x72))
    val SEPARATOR_COLOR = JBColor(Color(0x8C, 0x95, 0x9F), Color(0x8B, 0x94, 0x9E))

    fun reloadDocumentFromDisk(project: Project, virtualFile: VirtualFile?) {
        if (virtualFile == null || !virtualFile.isValid) return
        val ioFile = File(virtualFile.path)
        if (!ioFile.exists()) return

        virtualFile.refresh(false, false)
        val doc = FileDocumentManager.getInstance().getDocument(virtualFile) ?: return
        if (!doc.isWritable) {
            doc.setReadOnly(false)
        }
        val diskContent = try {
            ioFile.readText(Charsets.UTF_8).replace("\r\n", "\n")
        } catch (_: Exception) {
            null
        }
        if (diskContent != null && doc.text != diskContent) {
            WriteCommandAction.runWriteCommandAction(project) {
                doc.setText(diskContent)
                FileDocumentManager.getInstance().saveDocument(doc)
            }
        }
    }

    fun clearFileReview(project: Project, virtualFile: VirtualFile) {
        val fileEditorManager = FileEditorManager.getInstance(project)
        val ioFile = File(virtualFile.path)
        if (!ioFile.exists()) {
            fileEditorManager.closeFile(virtualFile)
            WriteCommandAction.runWriteCommandAction(project) {
                try { if (virtualFile.isValid) virtualFile.delete(this) } catch (_: Exception) {}
            }
            return
        }
        if (!virtualFile.isValid) return
        for (editor in fileEditorManager.getEditors(virtualFile)) {
            if (editor is TextEditor && !editor.editor.isDisposed) {
                clear(project, editor.editor, virtualFile)
            }
        }
        reloadDocumentFromDisk(project, virtualFile)
    }

    fun reloadAllOpenReviewEditors(project: Project) {
        val fileEditorManager = FileEditorManager.getInstance(project)
        for (editor in fileEditorManager.allEditors) {
            if (editor is TextEditor) {
                val vf = editor.file
                if (vf != null) {
                    val ioFile = File(vf.path)
                    if (!ioFile.exists()) {
                        fileEditorManager.closeFile(vf)
                        WriteCommandAction.runWriteCommandAction(project) {
                            try { if (vf.isValid) vf.delete(this) } catch (_: Exception) {}
                        }
                        continue
                    }
                    val rawEditor = editor.editor
                    if (rawEditor.getUserData(STAGED_HASH_KEY) != null) {
                        clear(project, rawEditor, vf)
                    }
                    if (vf.isValid) {
                        reloadDocumentFromDisk(project, vf)
                    }
                }
            }
        }
    }

    fun openReviewFile(project: Project, relPath: String) {
        val basePath = project.basePath ?: return
        val hubManager = project.getService(HubManager::class.java)
        val summary = hubManager.findChange(relPath)

        val file = File(basePath, relPath)
        // If file was deleted by AI, open Side-by-Side Diff Viewer so disk stays deleted for builds
        if (summary != null && !summary.proposedExists && !file.exists()) {
            ReviewHubDiffViewer.showDiff(project, summary)
            return
        }

        val lfs = LocalFileSystem.getInstance()
        val vf = lfs.refreshAndFindFileByIoFile(file) ?: lfs.findFileByIoFile(file)
        if (vf != null && file.exists()) {
            vf.refresh(false, false)
            FileEditorManager.getInstance(project).openFile(vf, true)
            return
        }

        if (summary == null) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val cs = hubManager.getChangeSet(summary.id, basePath) ?: return@executeOnPooledThread
            if (!cs.proposedExists) {
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        ReviewHubDiffViewer.showDiff(project, summary)
                    }
                }
                return@executeOnPooledThread
            }
            try {
                file.parentFile?.mkdirs()
                file.writeText(cs.proposed, Charsets.UTF_8)
            } catch (_: Exception) {
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val createdVf = lfs.refreshAndFindFileByIoFile(file)
                if (createdVf != null) {
                    FileEditorManager.getInstance(project).openFile(createdVf, true)
                }
                VirtualFileManager.getInstance().asyncRefresh(null)
            }
        }
    }

    fun clear(project: Project, editor: Editor, virtualFile: VirtualFile? = null) {
        val hadStaged = editor.getUserData(STAGED_HASH_KEY) != null
        val targetVf = virtualFile ?: FileDocumentManager.getInstance().getFile(editor.document)

        // 1. Remove highlighters
        val highlighters = editor.getUserData(HIGHLIGHTERS_KEY)
        highlighters?.forEach { editor.markupModel.removeHighlighter(it) }
        highlighters?.clear()

        // 2. Remove inlays
        val inlays = editor.getUserData(INLAYS_KEY)
        inlays?.forEach { Disposer.dispose(it) }
        inlays?.clear()

        // 3. Remove top header bar
        editor.headerComponent = null

        editor.putUserData(STAGED_HASH_KEY, null)
        editor.putUserData(HUNK_LINES_KEY, null)
        editor.putUserData(STAGED_ANCHORS_KEY, null)
        editor.putUserData(CHANGE_ID_KEY, null)
        editor.putUserData(REL_PATH_KEY, null)

        val doc = editor.document
        if (!doc.isWritable) {
            doc.setReadOnly(false)
        }

        // 4. Sync with disk content cleanly without triggering conflict warning
        if (hadStaged && targetVf != null && targetVf.isValid) {
            reloadDocumentFromDisk(project, targetVf)
        }
    }

    fun updateInlays(project: Project, editor: Editor, relPath: String) {
        val hubManager = project.getService(HubManager::class.java)
        val workspace = project.basePath ?: return
        val ioFile = File(workspace, relPath)
        val vf = LocalFileSystem.getInstance().findFileByIoFile(ioFile)

        // Direct in-memory fast-path (< 1ms, zero HTTP overhead)
        if (hubManager.isLocalStore) {
            val changeSet = hubManager.store.findChangeByPath(workspace, relPath)
            val runRender = Runnable {
                if (project.isDisposed || editor.isDisposed) return@Runnable
                if (changeSet == null || changeSet.status == "resolved" || !changeSet.proposedExists) {
                    if (changeSet != null && !changeSet.proposedExists && !ioFile.exists() && vf != null) {
                        FileEditorManager.getInstance(project).closeFile(vf)
                    } else {
                        clear(project, editor, vf)
                    }
                } else {
                    render(project, editor, changeSet.id, changeSet.baseline, changeSet.hunks, workspace, relPath, vf)
                }
            }
            if (ApplicationManager.getApplication().isDispatchThread) {
                runRender.run()
            } else {
                ApplicationManager.getApplication().invokeLater(runRender)
            }
            return
        }

        val client = hubManager.client ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val changeSummary = hubManager.findChange(relPath)

            if (changeSummary == null) {
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed && !editor.isDisposed) {
                        clear(project, editor, vf)
                    }
                }
                return@executeOnPooledThread
            }

            val changeSet = client.getChange(changeSummary.id, workspace) ?: return@executeOnPooledThread

            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed || editor.isDisposed) return@invokeLater
                if (!changeSet.proposedExists) {
                    if (!ioFile.exists() && vf != null) {
                        FileEditorManager.getInstance(project).closeFile(vf)
                    } else {
                        clear(project, editor, vf)
                    }
                } else {
                    render(project, editor, changeSet.id, changeSet.baseline, changeSet.hunks, workspace, relPath, vf)
                }
            }
        }
    }

    private fun render(
        project: Project,
        editor: Editor,
        changeId: String,
        baseline: String,
        hunks: List<Hunk>,
        workspace: String,
        relPath: String,
        virtualFile: VirtualFile?
    ) {
        val pendingHunks = hunks.filter { it.decision == "pending" }
        if (pendingHunks.isEmpty()) {
            clear(project, editor, virtualFile)
            return
        }

        val stagedView = MergedDiff.buildStagedView(baseline, hunks)
        val doc = editor.document

        val hunksSignature = pendingHunks.joinToString("|") { "${it.id}:${it.oldStart}:${it.newStart}:${it.oldLines.size}:${it.newLines.size}" }
        val currentHash = "${changeId}_${stagedView.text.hashCode()}_${hunksSignature.hashCode()}"
        val prevHash = editor.getUserData(STAGED_HASH_KEY)
        val hadStagedBefore = prevHash != null

        val prevCaretLine = editor.caretModel.logicalPosition.line
        val prevCaretCol = editor.caretModel.logicalPosition.column
        val prevScrollOffset = editor.scrollingModel.verticalScrollOffset

        if (prevHash != currentHash) {
            if (!doc.isWritable) {
                doc.setReadOnly(false)
            }
            if (virtualFile != null && virtualFile.isValid) {
                virtualFile.refresh(false, false)
            }
            WriteCommandAction.runWriteCommandAction(project) {
                if (doc.text != stagedView.text) {
                    doc.setText(stagedView.text)
                    FileDocumentManager.getInstance().saveDocument(doc)
                }
            }
            editor.putUserData(STAGED_HASH_KEY, currentHash)

            if (hadStagedBefore) {
                val safeLine = prevCaretLine.coerceIn(0, (doc.lineCount - 1).coerceAtLeast(0))
                editor.caretModel.moveToLogicalPosition(LogicalPosition(safeLine, prevCaretCol.coerceAtLeast(0)))
                editor.scrollingModel.scrollVertically(prevScrollOffset)
            }
        }

        editor.putUserData(STAGED_ANCHORS_KEY, stagedView.hunkAnchors)
        editor.putUserData(CHANGE_ID_KEY, changeId)
        editor.putUserData(REL_PATH_KEY, relPath)

        // Clean up previous highlighters and inlays
        val existingHighlighters = editor.getUserData(HIGHLIGHTERS_KEY)
        existingHighlighters?.forEach { editor.markupModel.removeHighlighter(it) }
        existingHighlighters?.clear()

        val existingInlays = editor.getUserData(INLAYS_KEY)
        existingInlays?.forEach { Disposer.dispose(it) }
        existingInlays?.clear()

        val activeHighlighters = mutableListOf<RangeHighlighter>()
        val activeInlays = mutableListOf<Inlay<*>>()

        val totalPendingCount = stagedView.hunkAnchors.size
        val maxLine = (doc.lineCount - 1).coerceAtLeast(0)

        for (anchor in stagedView.hunkAnchors) {
            val anchorLine = anchor.anchorLine.coerceIn(0, maxLine)
            val anchorLineOffset = if (doc.lineCount == 0) {
                0
            } else if (anchor.showAbove) {
                doc.getLineStartOffset(anchorLine)
            } else {
                doc.getLineEndOffset(anchorLine)
            }

            // Calculate indentation of the anchor line (or first deleted line)
            val lineText = if (doc.lineCount == 0) {
                ""
            } else {
                val startOff = doc.getLineStartOffset(anchorLine)
                val endOff = doc.getLineEndOffset(anchorLine)
                doc.charsSequence.subSequence(startOff, endOff).toString()
            }
            val sampleLine = if (lineText.isNotBlank()) lineText else (anchor.deletedLines.firstOrNull { it.isNotBlank() } ?: lineText)
            val indent = sampleLine.takeWhile { it.isWhitespace() }
            val addedCount = (anchor.addedEndLine - anchor.addedStartLine).coerceAtLeast(0)

            // Add Block Inlay for "✓Accept | ✕Reject" + Deleted Lines (so editor.document stays 100% clean)
            val renderer = HunkHeaderRenderer(
                editor = editor,
                indentText = indent,
                hunkId = anchor.hunkId,
                hunkNumber = anchor.hunkNumber,
                totalHunks = totalPendingCount,
                deletedLines = anchor.deletedLines,
                addedLinesCount = addedCount,
                onAccept = { decideHunk(project, changeId, workspace, relPath, anchor.hunkId, "accept") },
                onReject = { decideHunk(project, changeId, workspace, relPath, anchor.hunkId, "reject") }
            )

            val inlay = editor.inlayModel.addBlockElement(
                anchorLineOffset,
                false,
                anchor.showAbove,
                0,
                renderer
            )
            if (inlay != null) {
                activeInlays.add(inlay)
            }

            // Highlight added lines in green
            if (anchor.addedEndLine > anchor.addedStartLine && doc.lineCount > 0) {
                val startLine = anchor.addedStartLine.coerceIn(0, maxLine)
                val endLine = (anchor.addedEndLine - 1).coerceIn(startLine, maxLine)
                val startOffset = doc.getLineStartOffset(startLine)
                val endOffset = doc.getLineEndOffset(endLine)

                val attributes = TextAttributes().apply {
                    backgroundColor = GREEN_BG
                }

                val highlighter = editor.markupModel.addRangeHighlighter(
                    startOffset,
                    endOffset,
                    HighlighterLayer.SELECTION - 1,
                    attributes,
                    HighlighterTargetArea.LINES_IN_RANGE
                )
                activeHighlighters.add(highlighter)
            }
        }

        editor.putUserData(HIGHLIGHTERS_KEY, activeHighlighters)
        editor.putUserData(INLAYS_KEY, activeInlays)

        val hunkLines = stagedView.hunkAnchors.map { it.anchorLine }.sorted()
        editor.putUserData(HUNK_LINES_KEY, hunkLines)

        // Automatically scroll to the first pending hunk only when newly opened at top
        if (!hadStagedBefore && hunkLines.isNotEmpty() && prevCaretLine == 0) {
            val firstLine = hunkLines.first().coerceIn(0, maxLine)
            editor.caretModel.moveToLogicalPosition(LogicalPosition(firstLine, 0))
            editor.scrollingModel.scrollTo(LogicalPosition(firstLine, 0), ScrollType.CENTER)
        }

        // Unified compact header bar with file & hunk navigation
        editor.headerComponent = ReviewHubHeaderBar(project, editor, relPath, hunkLines.size)

        // Attach mouse listener once to handle clicks and hover on "✓Accept | ✕Reject"
        attachMouseListeners(editor)
    }

    private val inFlightHunks = Collections.synchronizedSet(mutableSetOf<String>())

    private fun attachMouseListeners(editor: Editor) {
        if (editor.getUserData(MOUSE_LISTENER_ATTACHED_KEY) == true) return
        editor.putUserData(MOUSE_LISTENER_ATTACHED_KEY, true)

        editor.addEditorMouseListener(object : EditorMouseListener {
            override fun mousePressed(e: EditorMouseEvent) {
                if (handleClick(editor, e.mouseEvent.point)) {
                    e.consume()
                }
            }
        })

        editor.addEditorMouseMotionListener(object : EditorMouseMotionListener {
            override fun mouseMoved(e: EditorMouseEvent) {
                handleMove(editor, e.mouseEvent.point)
            }
        })
    }

    private fun handleClick(editor: Editor, point: Point): Boolean {
        val inlays = editor.getUserData(INLAYS_KEY) ?: return false
        val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        val fm = editor.contentComponent.getFontMetrics(font)

        for (inlay in inlays) {
            if (!inlay.isValid) continue
            val renderer = inlay.renderer as? HunkHeaderRenderer ?: continue

            val accept = renderer.acceptBounds
            val reject = renderer.rejectBounds
            if (accept != null && accept.contains(point)) {
                renderer.onAccept()
                return true
            } else if (reject != null && reject.contains(point)) {
                renderer.onReject()
                return true
            }

            // Fallback bounds calculation for header row
            val headerHeight = renderer.headerRowHeight()
            val totalHeight = renderer.calcHeightInPixels(inlay)
            val realY = inlay.bounds?.y ?: (editor.visualPositionToXY(inlay.visualPosition).y - totalHeight)
            val startX = inlay.bounds?.x ?: 0

            val indentWidth = fm.stringWidth(renderer.indentText)
            val acceptStartX = startX + indentWidth
            val acceptWidth = fm.stringWidth("✓Accept")
            val acceptRect = Rectangle(acceptStartX - 8, realY - 2, acceptWidth + 16, headerHeight + 4)

            val sepWidth = fm.stringWidth(" | ")
            val rejectStartX = acceptStartX + acceptWidth + sepWidth
            val rejectWidth = fm.stringWidth("✕Reject")
            val rejectRect = Rectangle(rejectStartX - 8, realY - 2, rejectWidth + 16, headerHeight + 4)

            if (acceptRect.contains(point)) {
                renderer.onAccept()
                return true
            } else if (rejectRect.contains(point)) {
                renderer.onReject()
                return true
            }
        }
        return false
    }

    private fun handleMove(editor: Editor, point: Point) {
        val inlays = editor.getUserData(INLAYS_KEY) ?: return
        val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        val fm = editor.contentComponent.getFontMetrics(font)
        var cursorHand = false

        for (inlay in inlays) {
            if (!inlay.isValid) continue
            val renderer = inlay.renderer as? HunkHeaderRenderer ?: continue

            val headerHeight = renderer.headerRowHeight()
            val totalHeight = renderer.calcHeightInPixels(inlay)
            val realY = inlay.bounds?.y ?: (editor.visualPositionToXY(inlay.visualPosition).y - totalHeight)
            val startX = inlay.bounds?.x ?: 0

            val indentWidth = fm.stringWidth(renderer.indentText)
            val acceptStartX = startX + indentWidth
            val acceptWidth = fm.stringWidth("✓Accept")
            val acceptRect = Rectangle(acceptStartX - 8, realY - 2, acceptWidth + 16, headerHeight + 4)

            val sepWidth = fm.stringWidth(" | ")
            val rejectStartX = acceptStartX + acceptWidth + sepWidth
            val rejectWidth = fm.stringWidth("✕Reject")
            val rejectRect = Rectangle(rejectStartX - 8, realY - 2, rejectWidth + 16, headerHeight + 4)

            val inAccept = renderer.acceptBounds?.contains(point) == true || acceptRect.contains(point)
            val inReject = renderer.rejectBounds?.contains(point) == true || rejectRect.contains(point)

            if (renderer.setHover(inAccept, inReject)) {
                inlay.repaint()
            }
            if (inAccept || inReject) {
                cursorHand = true
            }
        }

        val currentCursor = editor.contentComponent.cursor
        if (cursorHand && currentCursor.type != Cursor.HAND_CURSOR) {
            editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        } else if (!cursorHand && currentCursor.type == Cursor.HAND_CURSOR) {
            editor.contentComponent.cursor = Cursor.getDefaultCursor()
        }
    }

    fun scrollToNextHunk(editor: Editor) {
        val lines = editor.getUserData(HUNK_LINES_KEY) ?: return
        if (lines.isEmpty()) return
        val currentLine = editor.caretModel.logicalPosition.line
        val target = lines.firstOrNull { it > currentLine } ?: lines.first()
        editor.caretModel.moveToLogicalPosition(LogicalPosition(target, 0))
        editor.scrollingModel.scrollTo(LogicalPosition(target, 0), ScrollType.CENTER)
    }

    fun scrollToPrevHunk(editor: Editor) {
        val lines = editor.getUserData(HUNK_LINES_KEY) ?: return
        if (lines.isEmpty()) return
        val currentLine = editor.caretModel.logicalPosition.line
        val target = lines.lastOrNull { it < currentLine } ?: lines.last()
        editor.caretModel.moveToLogicalPosition(LogicalPosition(target, 0))
        editor.scrollingModel.scrollTo(LogicalPosition(target, 0), ScrollType.CENTER)
    }

    fun hasPendingHunks(editor: Editor): Boolean {
        val lines = editor.getUserData(HUNK_LINES_KEY)
        return !lines.isNullOrEmpty()
    }

    /**
     * Because deleted lines are rendered inside Block Inlays rather than inside `editor.document`,
     * `editor.document.text` is always the clean valid file content (including any manual user edits).
     */
    fun extractResolvedContent(editor: Editor): String {
        return editor.document.text
    }

    fun decideCurrentHunk(project: Project, editor: Editor, kind: String) {
        val changeId = editor.getUserData(CHANGE_ID_KEY) ?: return
        val relPath = editor.getUserData(REL_PATH_KEY) ?: return
        val workspace = project.basePath ?: return
        val anchors = editor.getUserData(STAGED_ANCHORS_KEY) ?: return
        if (anchors.isEmpty()) return

        val caretLine = editor.caretModel.logicalPosition.line
        val targetAnchor = anchors.firstOrNull { anchor ->
            val maxEnd = anchor.addedEndLine.coerceAtLeast(anchor.anchorLine + 1)
            caretLine in (anchor.anchorLine - 1)..maxEnd
        } ?: anchors
            .sortedBy { it.anchorLine }
            .firstOrNull { it.anchorLine >= caretLine }
            ?: anchors.first()

        decideHunk(project, changeId, workspace, relPath, targetAnchor.hunkId, kind)
    }

    fun decideCurrentFile(project: Project, editor: Editor, kind: String) {
        val changeId = editor.getUserData(CHANGE_ID_KEY) ?: return
        val relPath = editor.getUserData(REL_PATH_KEY) ?: return
        val workspace = project.basePath ?: return
        val hubManager = project.getService(HubManager::class.java)
        val customText = if (kind == "accept") extractResolvedContent(editor) else null

        ApplicationManager.getApplication().executeOnPooledThread {
            if (kind == "accept") {
                hubManager.acceptChange(changeId = changeId, workspace = workspace, customContent = customText)
            } else {
                hubManager.rejectChange(changeId = changeId, workspace = workspace)
            }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val file = File(workspace, relPath)
                val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                if (vf != null) {
                    if (!file.exists()) {
                        FileEditorManager.getInstance(project).closeFile(vf)
                        WriteCommandAction.runWriteCommandAction(project) {
                            try { if (vf.isValid) vf.delete(this) } catch (_: Exception) {}
                        }
                    } else if (vf.isValid) {
                        clearFileReview(project, vf)
                    }
                }
                VirtualFileManager.getInstance().asyncRefresh(null)

                // Automatically advance to the next pending file if any remain
                val remaining = hubManager.changes.filter { it.status != "resolved" && it.id != changeId }
                if (remaining.isNotEmpty()) {
                    openReviewFile(project, remaining.first().path)
                }
            }
        }
    }

    private fun decideHunk(
        project: Project,
        changeId: String,
        workspace: String,
        relPath: String,
        hunkId: String,
        kind: String
    ) {
        val hunkKey = "$changeId:$hunkId"
        if (!inFlightHunks.add(hunkKey)) return
        val hubManager = project.getService(HubManager::class.java)

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (kind == "accept") {
                    hubManager.acceptChange(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                } else {
                    hubManager.rejectChange(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                }

                ApplicationManager.getApplication().invokeLater {
                    try {
                        if (project.isDisposed) return@invokeLater

                        val file = File(workspace, relPath)
                        val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                        if (vf != null && vf.isValid) {
                            if (!file.exists()) {
                                FileEditorManager.getInstance(project).closeFile(vf)
                                WriteCommandAction.runWriteCommandAction(project) {
                                    try { if (vf.isValid) vf.delete(this) } catch (_: Exception) {}
                                }
                            } else {
                                val editors = FileEditorManager.getInstance(project).getEditors(vf)
                                for (e in editors) {
                                    if (e is TextEditor && !e.editor.isDisposed) {
                                        updateInlays(project, e.editor, relPath)
                                    }
                                }
                            }
                        }
                        VirtualFileManager.getInstance().asyncRefresh(null)
                    } finally {
                        inFlightHunks.remove(hunkKey)
                    }
                }
            } catch (_: Throwable) {
                inFlightHunks.remove(hunkKey)
            }
        }
    }

    class HunkHeaderRenderer(
        private val editor: Editor,
        val indentText: String,
        val hunkId: String,
        val hunkNumber: Int,
        val totalHunks: Int = 1,
        val deletedLines: List<String> = emptyList(),
        val addedLinesCount: Int = 0,
        val onAccept: () -> Unit,
        val onReject: () -> Unit
    ) : EditorCustomElementRenderer {

        var acceptBounds: Rectangle? = null
        var rejectBounds: Rectangle? = null

        private var hoveredAccept = false
        private var hoveredReject = false

        fun setHover(accept: Boolean, reject: Boolean): Boolean {
            if (hoveredAccept != accept || hoveredReject != reject) {
                hoveredAccept = accept
                hoveredReject = reject
                return true
            }
            return false
        }

        fun headerRowHeight(): Int {
            return (editor.lineHeight * 0.95).toInt().coerceAtLeast(18)
        }

        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
            val fm = editor.contentComponent.getFontMetrics(font)
            val badge = buildBadgeText()
            val headerWidth = fm.stringWidth("$indentText✓Accept | ✕Reject$badge   ")
            val maxDeletedWidth = deletedLines.maxOfOrNull { fm.stringWidth(it) + 32 } ?: 0
            return maxOf(headerWidth, maxDeletedWidth, editor.contentComponent.width)
        }

        override fun calcHeightInPixels(inlay: Inlay<*>): Int {
            val hHeight = headerRowHeight()
            return if (deletedLines.isEmpty()) {
                hHeight
            } else {
                hHeight + (deletedLines.size * editor.lineHeight) + 2
            }
        }

        private fun buildBadgeText(): String {
            val stats = buildList {
                if (deletedLines.isNotEmpty()) add("-${deletedLines.size}")
                if (addedLinesCount > 0) add("+$addedLinesCount")
            }.joinToString(" ")
            val statsPart = if (stats.isNotEmpty()) "  ($stats)" else ""
            val indexPart = if (totalHunks > 1) "   #$hunkNumber/$totalHunks" else ""
            return "$indexPart$statsPart"
        }

        override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
                val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
                g2.font = font
                val fm = g2.fontMetrics

                val hHeight = headerRowHeight()
                val baseline = targetRegion.y + fm.ascent + (hHeight - fm.height) / 2
                var curX = targetRegion.x

                // 1. Indentation
                val indentWidth = fm.stringWidth(indentText)
                curX += indentWidth

                // 2. "✓Accept"
                val acceptStr = "✓Accept"
                val acceptWidth = fm.stringWidth(acceptStr)
                val pillY = targetRegion.y + 1
                val pillH = (hHeight - 2).coerceAtLeast(14)
                acceptBounds = Rectangle(curX - 6, targetRegion.y - 2, acceptWidth + 12, hHeight + 4)

                if (hoveredAccept) {
                    g2.color = ACCEPT_PILL_BG
                    g2.fillRoundRect(curX - 5, pillY, acceptWidth + 10, pillH, 6, 6)
                }
                g2.color = if (hoveredAccept) ACCEPT_HOVER_COLOR else ACCEPT_COLOR
                g2.drawString(acceptStr, curX, baseline)
                curX += acceptWidth

                // 3. " | "
                val sepStr = " | "
                val sepWidth = fm.stringWidth(sepStr)
                g2.color = SEPARATOR_COLOR
                g2.drawString(sepStr, curX, baseline)
                curX += sepWidth

                // 4. "✕Reject"
                val rejectStr = "✕Reject"
                val rejectWidth = fm.stringWidth(rejectStr)
                rejectBounds = Rectangle(curX - 6, targetRegion.y - 2, rejectWidth + 12, hHeight + 4)

                if (hoveredReject) {
                    g2.color = REJECT_PILL_BG
                    g2.fillRoundRect(curX - 5, pillY, rejectWidth + 10, pillH, 6, 6)
                }
                g2.color = if (hoveredReject) REJECT_HOVER_COLOR else REJECT_COLOR
                g2.drawString(rejectStr, curX, baseline)
                curX += rejectWidth

                // 5. Hunk counter & line stats badge
                val badgeStr = buildBadgeText()
                if (badgeStr.isNotEmpty()) {
                    g2.color = SEPARATOR_COLOR
                    g2.drawString(badgeStr, curX, baseline)
                }

                // 6. Deleted lines block rendered cleanly inside the Inlay (never polluting editor.document)
                if (deletedLines.isNotEmpty()) {
                    val lineHeight = editor.lineHeight
                    val blockY = targetRegion.y + hHeight
                    val blockH = deletedLines.size * lineHeight + 2
                    val fullW = maxOf(targetRegion.width, editor.contentComponent.width)

                    g2.color = RED_BG
                    g2.fillRect(targetRegion.x, blockY, fullW, blockH)

                    g2.color = DELETED_TEXT_COLOR
                    for ((idx, delLine) in deletedLines.withIndex()) {
                        val lineY = blockY + (idx * lineHeight) + fm.ascent + (lineHeight - fm.height) / 2
                        val displayLine = delLine.replace("\t", "    ")
                        g2.drawString(displayLine, targetRegion.x, lineY)
                    }
                }
            } finally {
                g2.dispose()
            }
        }
    }
}
