package com.reviewhub.core

import com.reviewhub.model.Hunk

enum class EditType { EQUAL, DELETE, INSERT }
data class DiffEdit(val type: EditType, val oldIdx: Int, val newIdx: Int)

object HunkDiff {

    fun computeHunks(baseline: String, proposed: String): List<Hunk> {
        val oldLines = if (baseline.isEmpty()) emptyList() else baseline.split("\n").map { it.trimEnd('\r') }
        val newLines = if (proposed.isEmpty()) emptyList() else proposed.split("\n").map { it.trimEnd('\r') }

        if (oldLines == newLines) {
            return emptyList()
        }

        if (oldLines.isEmpty()) {
            return listOf(
                Hunk(
                    id = "hunk-1",
                    oldStart = 0,
                    oldLines = emptyList(),
                    newStart = 0,
                    newLines = newLines,
                    decision = "pending"
                )
            )
        }

        if (newLines.isEmpty()) {
            return listOf(
                Hunk(
                    id = "hunk-1",
                    oldStart = 0,
                    oldLines = oldLines,
                    newStart = 0,
                    newLines = emptyList(),
                    decision = "pending"
                )
            )
        }

        return computeDiffHunks(oldLines, newLines)
    }

    private fun computeDiffHunks(oldLines: List<String>, newLines: List<String>): List<Hunk> {
        val m = oldLines.size
        val n = newLines.size

        val dp = Array(m + 1) { IntArray(n + 1) }

        for (i in 1..m) {
            for (j in 1..n) {
                if (oldLines[i - 1] == newLines[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = maxOf(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }

        var i = m
        var j = n

        val edits = mutableListOf<DiffEdit>()

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] == newLines[j - 1]) {
                edits.add(DiffEdit(EditType.EQUAL, i - 1, j - 1))
                i--
                j--
            } else if (j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                edits.add(DiffEdit(EditType.INSERT, i, j - 1))
                j--
            } else if (i > 0 && (j == 0 || dp[i][j - 1] < dp[i - 1][j])) {
                edits.add(DiffEdit(EditType.DELETE, i - 1, j))
                i--
            }
        }

        edits.reverse()

        val hunks = mutableListOf<Hunk>()
        var hunkCounter = 1

        var idx = 0
        while (idx < edits.size) {
            val edit = edits[idx]
            if (edit.type == EditType.EQUAL) {
                idx++
                continue
            }

            val hunkOldStart = edit.oldIdx
            val hunkNewStart = edit.newIdx

            val hunkOldLines = mutableListOf<String>()
            val hunkNewLines = mutableListOf<String>()

            while (idx < edits.size && edits[idx].type != EditType.EQUAL) {
                val current = edits[idx]
                if (current.type == EditType.DELETE) {
                    hunkOldLines.add(oldLines[current.oldIdx])
                } else if (current.type == EditType.INSERT) {
                    hunkNewLines.add(newLines[current.newIdx])
                }
                idx++
            }

            hunks.add(
                Hunk(
                    id = "hunk-$hunkCounter",
                    oldStart = hunkOldStart,
                    oldLines = hunkOldLines,
                    newStart = hunkNewStart,
                    newLines = hunkNewLines,
                    decision = "pending"
                )
            )
            hunkCounter++
        }

        return hunks
    }

    fun resolve(baseline: String, hunks: List<Hunk>): String {
        val baseLines = if (baseline.isEmpty()) emptyList() else baseline.split("\n").map { it.trimEnd('\r') }
        val resultLines = mutableListOf<String>()

        val sortedHunks = hunks.sortedBy { it.oldStart }
        var baseIdx = 0

        for (hunk in sortedHunks) {
            if (hunk.oldStart > baseIdx) {
                val endSlice = hunk.oldStart.coerceAtMost(baseLines.size)
                if (endSlice > baseIdx) {
                    resultLines.addAll(baseLines.subList(baseIdx, endSlice))
                }
                baseIdx = hunk.oldStart
            }

            when (hunk.decision) {
                "accepted" -> {
                    resultLines.addAll(hunk.newLines)
                    baseIdx += hunk.oldLines.size
                }
                "rejected" -> {
                    resultLines.addAll(hunk.oldLines)
                    baseIdx += hunk.oldLines.size
                }
                else -> { // "pending"
                    resultLines.addAll(hunk.oldLines)
                    baseIdx += hunk.oldLines.size
                }
            }
        }

        if (baseIdx < baseLines.size) {
            resultLines.addAll(baseLines.subList(baseIdx, baseLines.size))
        }

        return resultLines.joinToString("\n")
    }

    fun resolveStaged(baseline: String, hunks: List<Hunk>): String {
        val baseLines = if (baseline.isEmpty()) emptyList() else baseline.split("\n").map { it.trimEnd('\r') }
        val resultLines = mutableListOf<String>()

        val sortedHunks = hunks.sortedBy { it.oldStart }
        var baseIdx = 0

        for (hunk in sortedHunks) {
            if (hunk.oldStart > baseIdx) {
                val endSlice = hunk.oldStart.coerceAtMost(baseLines.size)
                if (endSlice > baseIdx) {
                    resultLines.addAll(baseLines.subList(baseIdx, endSlice))
                }
                baseIdx = hunk.oldStart
            }

            when (hunk.decision) {
                "rejected" -> {
                    resultLines.addAll(hunk.oldLines)
                    baseIdx += hunk.oldLines.size
                }
                else -> { // "accepted" or "pending" -> show proposed lines in editor
                    resultLines.addAll(hunk.newLines)
                    baseIdx += hunk.oldLines.size
                }
            }
        }

        if (baseIdx < baseLines.size) {
            resultLines.addAll(baseLines.subList(baseIdx, baseLines.size))
        }

        return resultLines.joinToString("\n")
    }
}
