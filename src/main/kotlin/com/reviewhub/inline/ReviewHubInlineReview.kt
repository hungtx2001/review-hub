package com.reviewhub.inline

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
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
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.event.MouseMotionAdapter
import java.io.File
import javax.swing.Icon

object ReviewHubInlineReview {
    private val HIGHLIGHTERS_KEY = Key.create<MutableList<RangeHighlighter>>("reviewhub.highlighters")
    private val DELETED_HIGHLIGHTERS_KEY = Key.create<MutableList<RangeHighlighter>>("reviewhub.deleted_highlighters")
    private val INLAYS_KEY = Key.create<MutableList<Inlay<*>>>("reviewhub.inlays")
    private val STAGED_HASH_KEY = Key.create<String>("reviewhub.staged_hash")
    private val MOUSE_LISTENER_ATTACHED_KEY = Key.create<Boolean>("reviewhub.mouse_listener_attached")
    private val HUNK_LINES_KEY = Key.create<List<Int>>("reviewhub.hunk_lines")
    private val MERGED_BLOCKS_KEY = Key.create<List<MergedBlock>>("reviewhub.merged_blocks")

    // Colors matching the UI in Antigravity / Inline Review
    private val RED_BG = JBColor(Color(0xFF, 0xEB, 0xEC), Color(0x4C, 0x1C, 0x24))
    private val GREEN_BG = JBColor(Color(0xE6, 0xFF, 0xED), Color(0x1F, 0x3E, 0x24))
    private val GREEN_GUTTER = JBColor(Color(0x2E, 0xA0, 0x43), Color(0x3F, 0xB9, 0x50))

    val ACCEPT_COLOR = JBColor(Color(0x1A, 0x7F, 0x37), Color(0x56, 0xD3, 0x64))
    val ACCEPT_HOVER_COLOR = JBColor(Color(0x11, 0x63, 0x29), Color(0x7E, 0xE7, 0x87))
    val REJECT_COLOR = JBColor(Color(0xCF, 0x22, 0x2E), Color(0xF8, 0x51, 0x49))
    val REJECT_HOVER_COLOR = JBColor(Color(0xA4, 0x0E, 0x26), Color(0xFF, 0x7B, 0x72))
    val SEPARATOR_COLOR = JBColor(Color(0x8C, 0x95, 0x9F), Color(0x8B, 0x94, 0x9E))

    fun reloadDocumentFromDisk(project: Project, virtualFile: VirtualFile?) {
        if (virtualFile == null || !virtualFile.isValid) return
        val doc = FileDocumentManager.getInstance().getDocument(virtualFile) ?: return
        if (!doc.isWritable) {
            doc.setReadOnly(false)
        }
        virtualFile.refresh(false, false)
        try {
            FileDocumentManager.getInstance().reloadFromDisk(doc)
        } catch (_: Exception) {
        }
    }

    fun clearFileReview(project: Project, virtualFile: VirtualFile) {
        if (!virtualFile.isValid) return
        val fileEditorManager = FileEditorManager.getInstance(project)
        for (editor in fileEditorManager.getEditors(virtualFile)) {
            if (editor is TextEditor && !editor.editor.isDisposed) {
                clear(project, editor.editor, virtualFile)
            }
        }
        val ioFile = File(virtualFile.path)
        if (!ioFile.exists()) {
            fileEditorManager.closeFile(virtualFile)
        } else {
            reloadDocumentFromDisk(project, virtualFile)
        }
    }

    fun reloadAllOpenReviewEditors(project: Project) {
        val fileEditorManager = FileEditorManager.getInstance(project)
        for (editor in fileEditorManager.allEditors) {
            if (editor is TextEditor) {
                val vf = editor.file
                val rawEditor = editor.editor
                if (rawEditor.getUserData(STAGED_HASH_KEY) != null) {
                    clear(project, rawEditor, vf)
                }
                if (vf != null && vf.isValid) {
                    if (!File(vf.path).exists()) {
                        fileEditorManager.closeFile(vf)
                    } else {
                        reloadDocumentFromDisk(project, vf)
                    }
                }
            }
        }
    }

    fun openReviewFile(project: Project, relPath: String) {
        val basePath = project.basePath ?: return
        val file = File(basePath, relPath)
        val lfs = LocalFileSystem.getInstance()
        val vf = lfs.refreshAndFindFileByIoFile(file) ?: lfs.findFileByIoFile(file)
        if (vf != null && file.exists()) {
            FileEditorManager.getInstance(project).openFile(vf, true)
            return
        }

        val hubManager = project.getService(HubManager::class.java)
        val summary = hubManager.findChange(relPath) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val client = hubManager.client ?: return@executeOnPooledThread
            val content = client.getChange(summary.id, basePath)?.proposed ?: ""
            try {
                file.parentFile?.mkdirs()
                file.writeText(content, Charsets.UTF_8)
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
        editor.getUserData(DELETED_HIGHLIGHTERS_KEY)?.clear()

        // 2. Remove inlays
        val inlays = editor.getUserData(INLAYS_KEY)
        inlays?.forEach { Disposer.dispose(it) }
        inlays?.clear()

        // 3. Remove top header bar
        editor.headerComponent = null

        editor.putUserData(STAGED_HASH_KEY, null)
        editor.putUserData(HUNK_LINES_KEY, null)
        editor.putUserData(MERGED_BLOCKS_KEY, null)

        val doc = editor.document
        if (!doc.isWritable) {
            doc.setReadOnly(false)
        }

        // 4. Restore disk content cleanly without triggering conflict warning
        if (hadStaged && targetVf != null && targetVf.isValid) {
            targetVf.refresh(false, false)
            try {
                FileDocumentManager.getInstance().reloadFromDisk(doc)
            } catch (_: Exception) {
                val diskContent = try {
                    String(targetVf.contentsToByteArray(), targetVf.charset)
                } catch (_: Exception) {
                    null
                }
                if (diskContent != null && doc.text != diskContent) {
                    WriteCommandAction.runWriteCommandAction(project) {
                        doc.setText(diskContent)
                    }
                }
            }
        }
    }

    fun updateInlays(project: Project, editor: Editor, relPath: String) {
        val hubManager = project.getService(HubManager::class.java)
        val client = hubManager.client ?: return
        val workspace = project.basePath ?: return
        val vf = LocalFileSystem.getInstance().findFileByIoFile(File(workspace, relPath))

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
                render(project, editor, changeSet.id, changeSet.baseline, changeSet.hunks, workspace, relPath, vf)
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

        val merged = MergedDiff.build(baseline, hunks)
        val doc = editor.document

        val currentHash = "${changeId}_${merged.text.hashCode()}"
        val prevHash = editor.getUserData(STAGED_HASH_KEY)

        if (prevHash != currentHash) {
            if (!doc.isWritable) {
                doc.setReadOnly(false)
            }
            WriteCommandAction.runWriteCommandAction(project) {
                if (doc.text != merged.text) {
                    doc.setText(merged.text)
                }
            }
            // Allow developer to directly tweak/edit proposed code in editor before accept
            if (!doc.isWritable) {
                doc.setReadOnly(false)
            }
            editor.putUserData(STAGED_HASH_KEY, currentHash)
        }
        editor.putUserData(MERGED_BLOCKS_KEY, merged.blocks)


        // Clean up previous highlighters and inlays
        val existingHighlighters = editor.getUserData(HIGHLIGHTERS_KEY)
        existingHighlighters?.forEach { editor.markupModel.removeHighlighter(it) }
        existingHighlighters?.clear()
        editor.getUserData(DELETED_HIGHLIGHTERS_KEY)?.clear()

        val existingInlays = editor.getUserData(INLAYS_KEY)
        existingInlays?.forEach { Disposer.dispose(it) }
        existingInlays?.clear()

        val activeHighlighters = mutableListOf<RangeHighlighter>()
        val deletedHighlighters = mutableListOf<RangeHighlighter>()
        val activeInlays = mutableListOf<Inlay<*>>()

        // Green gutter vertical bar renderer
        val greenGutterMarker = LineMarkerRenderer { _, g, r ->
            g.color = GREEN_GUTTER
            g.fillRect(r.x + r.width - 4, r.y, 4, r.height)
        }

        // Group blocks by hunkId so we can attach a single "✓Accept | ✕Reject" header above each hunk
        val blocksByHunk = merged.blocks
            .filter { it.kind != MergedBlockKind.CONTEXT && it.hunkId != null }
            .groupBy { it.hunkId }

        for ((hunkId, blocks) in blocksByHunk) {
            if (hunkId == null) continue
            val firstBlock = blocks.minByOrNull { it.startLine } ?: continue
            val hunkNumber = firstBlock.hunkIndex

            val maxLine = (doc.lineCount - 1).coerceAtLeast(0)
            val firstStartLine = firstBlock.startLine.coerceIn(0, maxLine)
            val firstLineOffset = doc.getLineStartOffset(firstStartLine)

            // Calculate indentation of the first line in this hunk
            val lineStartOffset = doc.getLineStartOffset(firstStartLine)
            val lineEndOffset = doc.getLineEndOffset(firstStartLine)
            val lineText = doc.charsSequence.subSequence(lineStartOffset, lineEndOffset).toString()
            val indent = lineText.takeWhile { it.isWhitespace() }

            // Add Block Inlay for "✓Accept | ✕Reject" above the hunk
            val renderer = HunkHeaderRenderer(
                editor = editor,
                indentText = indent,
                hunkId = hunkId,
                hunkNumber = hunkNumber,
                onAccept = { decideHunk(project, changeId, workspace, relPath, hunkId, "accept") },
                onReject = { decideHunk(project, changeId, workspace, relPath, hunkId, "reject") }
            )

            val inlay = editor.inlayModel.addBlockElement(
                firstLineOffset,
                false,
                true,
                0,
                renderer
            )
            if (inlay != null) {
                activeInlays.add(inlay)
            }

            // Highlight lines for each block in this hunk
            for (block in blocks) {
                val startLine = block.startLine.coerceIn(0, maxLine)
                val endLine = (block.endLine - 1).coerceIn(startLine, maxLine)
                val startOffset = doc.getLineStartOffset(startLine)
                val endOffset = doc.getLineEndOffset(endLine)

                val isDeleted = block.kind == MergedBlockKind.DELETED
                val attributes = TextAttributes().apply {
                    backgroundColor = if (isDeleted) RED_BG else GREEN_BG
                }

                val highlighter = editor.markupModel.addRangeHighlighter(
                    startOffset,
                    endOffset,
                    HighlighterLayer.SELECTION - 1,
                    attributes,
                    HighlighterTargetArea.LINES_IN_RANGE
                )

                if (!isDeleted) {
                    highlighter.lineMarkerRenderer = greenGutterMarker
                } else {
                    highlighter.isGreedyToLeft = false
                    highlighter.isGreedyToRight = false
                    deletedHighlighters.add(highlighter)
                }

                activeHighlighters.add(highlighter)
            }
        }

        editor.putUserData(HIGHLIGHTERS_KEY, activeHighlighters)
        editor.putUserData(DELETED_HIGHLIGHTERS_KEY, deletedHighlighters)
        editor.putUserData(INLAYS_KEY, activeInlays)

        val hunkLines = blocksByHunk.values.mapNotNull { blocks ->
            blocks.minByOrNull { it.startLine }?.startLine
        }.sorted()
        editor.putUserData(HUNK_LINES_KEY, hunkLines)

        // Automatically scroll to the first pending hunk if opened at top
        if (hunkLines.isNotEmpty()) {
            val firstLine = hunkLines.first()
            val currentLine = editor.caretModel.logicalPosition.line
            if (currentLine == 0) {
                editor.caretModel.moveToLogicalPosition(com.intellij.openapi.editor.LogicalPosition(firstLine, 0))
                editor.scrollingModel.scrollTo(com.intellij.openapi.editor.LogicalPosition(firstLine, 0), com.intellij.openapi.editor.ScrollType.CENTER)
            }
        }

        // Add header bar with file switcher, hunk navigation, Diff viewer, and Accept/Reject buttons
        editor.headerComponent = ReviewHubHeaderBar(project, editor, relPath)

        // Attach mouse listener once to handle clicks and hover on "✓Accept | ✕Reject"
        attachMouseListeners(editor)
    }

    private val inFlightHunks = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    private fun attachMouseListeners(editor: Editor) {
        if (editor.getUserData(MOUSE_LISTENER_ATTACHED_KEY) == true) return
        editor.putUserData(MOUSE_LISTENER_ATTACHED_KEY, true)

        // EditorMouseListener handles IDE-level mouse events without duplicating Swing callbacks
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

            // 1. Check direct bounds recorded during paint()
            val accept = renderer.acceptBounds
            val reject = renderer.rejectBounds
            if (accept != null && accept.contains(point)) {
                renderer.onAccept()
                return true
            } else if (reject != null && reject.contains(point)) {
                renderer.onReject()
                return true
            }

            // 2. Precise fallback: showAbove=true places inlay ABOVE anchor visual line
            val height = renderer.calcHeightInPixels(inlay)
            val realY = inlay.bounds?.y ?: (editor.visualPositionToXY(inlay.visualPosition).y - height)
            val startX = inlay.bounds?.x ?: 0

            val indentWidth = fm.stringWidth(renderer.indentText)
            val acceptStartX = startX + indentWidth
            val acceptWidth = fm.stringWidth("✓Accept")
            val acceptRect = Rectangle(acceptStartX - 8, realY - 4, acceptWidth + 16, height + 8)

            val sepWidth = fm.stringWidth(" | ")
            val rejectStartX = acceptStartX + acceptWidth + sepWidth
            val rejectWidth = fm.stringWidth("✕Reject")
            val rejectRect = Rectangle(rejectStartX - 8, realY - 4, rejectWidth + 16, height + 8)

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

            val height = renderer.calcHeightInPixels(inlay)
            val realY = inlay.bounds?.y ?: (editor.visualPositionToXY(inlay.visualPosition).y - height)
            val startX = inlay.bounds?.x ?: 0

            val indentWidth = fm.stringWidth(renderer.indentText)
            val acceptStartX = startX + indentWidth
            val acceptWidth = fm.stringWidth("✓Accept")
            val acceptRect = Rectangle(acceptStartX - 8, realY - 4, acceptWidth + 16, height + 8)

            val sepWidth = fm.stringWidth(" | ")
            val rejectStartX = acceptStartX + acceptWidth + sepWidth
            val rejectWidth = fm.stringWidth("✕Reject")
            val rejectRect = Rectangle(rejectStartX - 8, realY - 4, rejectWidth + 16, height + 8)

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
        editor.caretModel.moveToLogicalPosition(com.intellij.openapi.editor.LogicalPosition(target, 0))
        editor.scrollingModel.scrollTo(com.intellij.openapi.editor.LogicalPosition(target, 0), com.intellij.openapi.editor.ScrollType.CENTER)
    }

    fun scrollToPrevHunk(editor: Editor) {
        val lines = editor.getUserData(HUNK_LINES_KEY) ?: return
        if (lines.isEmpty()) return
        val currentLine = editor.caretModel.logicalPosition.line
        val target = lines.lastOrNull { it < currentLine } ?: lines.last()
        editor.caretModel.moveToLogicalPosition(com.intellij.openapi.editor.LogicalPosition(target, 0))
        editor.scrollingModel.scrollTo(com.intellij.openapi.editor.LogicalPosition(target, 0), com.intellij.openapi.editor.ScrollType.CENTER)
    }

    fun hasPendingHunks(editor: Editor): Boolean {
        val lines = editor.getUserData(HUNK_LINES_KEY)
        return !lines.isNullOrEmpty()
    }

    fun extractResolvedContent(editor: Editor): String {
        val doc = editor.document
        val deletedHighlighters = editor.getUserData(DELETED_HIGHLIGHTERS_KEY)
        val deletedLines = mutableSetOf<Int>()

        if (!deletedHighlighters.isNullOrEmpty()) {
            for (h in deletedHighlighters) {
                if (h.isValid && h.startOffset <= h.endOffset && h.endOffset <= doc.textLength) {
                    val startLine = doc.getLineNumber(h.startOffset)
                    val endLine = doc.getLineNumber(h.endOffset)
                    for (line in startLine..endLine) {
                        deletedLines.add(line)
                    }
                }
            }
        } else {
            val blocks = editor.getUserData(MERGED_BLOCKS_KEY)
            if (blocks.isNullOrEmpty()) {
                return doc.text
            }
            for (b in blocks) {
                if (b.kind == MergedBlockKind.DELETED) {
                    for (line in b.startLine until b.endLine) {
                        deletedLines.add(line)
                    }
                }
            }
        }

        val lineCount = doc.lineCount
        val resultLines = mutableListOf<String>()
        for (i in 0 until lineCount) {
            if (i !in deletedLines) {
                val start = doc.getLineStartOffset(i)
                val end = doc.getLineEndOffset(i)
                resultLines.add(doc.charsSequence.subSequence(start, end).toString())
            }
        }
        return resultLines.joinToString("\n")
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
        val client = hubManager.client ?: run {
            inFlightHunks.remove(hunkKey)
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (kind == "accept") {
                    client.accept(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                } else {
                    client.reject(changeId = changeId, workspace = workspace, hunkIds = listOf(hunkId))
                }

                hubManager.refresh()

                ApplicationManager.getApplication().invokeLater {
                    try {
                        if (project.isDisposed) return@invokeLater

                        val file = File(workspace, relPath)
                        val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                        if (vf != null && vf.isValid) {
                            if (!file.exists()) {
                                FileEditorManager.getInstance(project).closeFile(vf)
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
            } catch (e: Throwable) {
                inFlightHunks.remove(hunkKey)
            }
        }
    }

    class HunkHeaderRenderer(
        private val editor: Editor,
        val indentText: String,
        val hunkId: String,
        val hunkNumber: Int,
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

        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
            val fm = editor.contentComponent.getFontMetrics(font)
            return fm.stringWidth("$indentText✓Accept | ✕Reject   ")
        }

        override fun calcHeightInPixels(inlay: Inlay<*>): Int {
            return (editor.lineHeight * 0.95).toInt().coerceAtLeast(18)
        }

        override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
                val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
                g2.font = font
                val fm = g2.fontMetrics

                val baseline = targetRegion.y + fm.ascent + (targetRegion.height - fm.height) / 2
                var curX = targetRegion.x

                // 1. Indentation
                val indentWidth = fm.stringWidth(indentText)
                curX += indentWidth

                // 2. "✓Accept"
                val acceptStr = "✓Accept"
                val acceptWidth = fm.stringWidth(acceptStr)
                acceptBounds = Rectangle(curX - 6, targetRegion.y - 2, acceptWidth + 12, targetRegion.height + 4)

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
                rejectBounds = Rectangle(curX - 6, targetRegion.y - 2, rejectWidth + 12, targetRegion.height + 4)

                g2.color = if (hoveredReject) REJECT_HOVER_COLOR else REJECT_COLOR
                g2.drawString(rejectStr, curX, baseline)
            } finally {
                g2.dispose()
            }
        }
    }
}
