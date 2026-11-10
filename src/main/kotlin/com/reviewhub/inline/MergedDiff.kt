package com.reviewhub.inline

import com.reviewhub.model.Hunk

enum class MergedBlockKind {
    CONTEXT, DELETED, ADDED
}

data class MergedBlock(
    val kind: MergedBlockKind,
    val startLine: Int,
    val endLine: Int, // exclusive
    val hunkId: String? = null,
    val hunkIndex: Int = -1
)

data class MergedView(
    val text: String,
    val lines: List<String>,
    val blocks: List<MergedBlock>
)

data class StagedHunkAnchor(
    val hunkId: String,
    val hunkNumber: Int,
    val anchorLine: Int,
    val addedStartLine: Int,
    val addedEndLine: Int, // exclusive
    val deletedLines: List<String>
)

data class StagedEditorView(
    val text: String,
    val lines: List<String>,
    val hunkAnchors: List<StagedHunkAnchor>
)

object MergedDiff {
    /**
     * Builds a clean StagedEditorView where `text` contains ONLY valid compilable code
     * (matching the live disk file 100%, without interleaving deleted lines into the document),
     * while recording exact line anchors and `deletedLines` for Block Inlay rendering.
     */
    fun buildStagedView(baselineText: String, hunks: List<Hunk>): StagedEditorView {
        val baseLines = if (baselineText.isEmpty()) emptyList() else baselineText.split("\n").map { it.trimEnd('\r') }
        val lines = mutableListOf<String>()
        val rawAnchors = mutableListOf<StagedHunkAnchor>()

        val sortedHunks = hunks.sortedBy { it.oldStart }
        var baseIdx = 0
        var pendingOrder = 1

        for (hunk in sortedHunks) {
            if (hunk.oldStart > baseIdx) {
                val endSlice = hunk.oldStart.coerceAtMost(baseLines.size)
                if (endSlice > baseIdx) {
                    lines.addAll(baseLines.subList(baseIdx, endSlice))
                }
                baseIdx = hunk.oldStart
            }

            when (hunk.decision) {
                "accepted" -> {
                    lines.addAll(hunk.newLines)
                    baseIdx += hunk.oldLines.size
                }
                "rejected" -> {
                    lines.addAll(hunk.oldLines)
                    baseIdx += hunk.oldLines.size
                }
                else -> { // "pending"
                    val startLine = lines.size
                    lines.addAll(hunk.newLines)
                    val endLine = lines.size
                    baseIdx += hunk.oldLines.size

                    rawAnchors.add(
                        StagedHunkAnchor(
                            hunkId = hunk.id,
                            hunkNumber = pendingOrder++,
                            anchorLine = startLine,
                            addedStartLine = startLine,
                            addedEndLine = endLine,
                            deletedLines = hunk.oldLines
                        )
                    )
                }
            }
        }

        if (baseIdx < baseLines.size) {
            lines.addAll(baseLines.subList(baseIdx, baseLines.size))
        }

        val maxValidLine = (lines.size - 1).coerceAtLeast(0)
        val clampedAnchors = rawAnchors.map { anchor ->
            anchor.copy(
                anchorLine = anchor.anchorLine.coerceIn(0, maxValidLine)
            )
        }

        val text = lines.joinToString("\n")
        return StagedEditorView(text = text, lines = lines, hunkAnchors = clampedAnchors)
    }

    fun build(baselineText: String, hunks: List<Hunk>): MergedView {
        val baseLines = if (baselineText.isEmpty()) emptyList() else baselineText.split("\n").map { it.trimEnd('\r') }
        val lines = mutableListOf<String>()
        val blocks = mutableListOf<MergedBlock>()

        val sortedHunks = hunks.sortedBy { it.oldStart }
        var baseIdx = 0

        for ((index, hunk) in sortedHunks.withIndex()) {
            // 1. Context lines before hunk
            if (hunk.oldStart > baseIdx) {
                val endSlice = hunk.oldStart.coerceAtMost(baseLines.size)
                if (endSlice > baseIdx) {
                    val contextSlice = baseLines.subList(baseIdx, endSlice)
                    val start = lines.size
                    lines.addAll(contextSlice)
                    blocks.add(MergedBlock(MergedBlockKind.CONTEXT, start, lines.size))
                }
                baseIdx = hunk.oldStart
            }

            when (hunk.decision) {
                "accepted" -> {
                    // Accepted hunk: its proposed lines are accepted and appear as context
                    if (hunk.newLines.isNotEmpty()) {
                        val start = lines.size
                        lines.addAll(hunk.newLines)
                        blocks.add(MergedBlock(MergedBlockKind.CONTEXT, start, lines.size))
                    }
                    baseIdx += hunk.oldLines.size
                }
                "rejected" -> {
                    // Rejected hunk: its baseline lines remain as context
                    if (hunk.oldLines.isNotEmpty()) {
                        val start = lines.size
                        lines.addAll(hunk.oldLines)
                        blocks.add(MergedBlock(MergedBlockKind.CONTEXT, start, lines.size))
                    }
                    baseIdx += hunk.oldLines.size
                }
                else -> {
                    // 2. Deleted lines (from baseline)
                    if (hunk.oldLines.isNotEmpty()) {
                        val start = lines.size
                        lines.addAll(hunk.oldLines)
                        blocks.add(MergedBlock(MergedBlockKind.DELETED, start, lines.size, hunk.id, index + 1))
                        baseIdx += hunk.oldLines.size
                    }

                    // 3. Added lines (from proposal)
                    if (hunk.newLines.isNotEmpty()) {
                        val start = lines.size
                        lines.addAll(hunk.newLines)
                        blocks.add(MergedBlock(MergedBlockKind.ADDED, start, lines.size, hunk.id, index + 1))
                    }
                }
            }
        }

        // 4. Remaining context lines
        if (baseIdx < baseLines.size) {
            val remaining = baseLines.subList(baseIdx, baseLines.size)
            if (remaining.isNotEmpty()) {
                val start = lines.size
                lines.addAll(remaining)
                blocks.add(MergedBlock(MergedBlockKind.CONTEXT, start, lines.size))
            }
        }

        val text = lines.joinToString("\n")
        return MergedView(text, lines, blocks)
    }
}
