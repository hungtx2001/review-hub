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

object MergedDiff {
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
