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
        val edits = computeDiffEdits(oldLines, newLines)
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

    /**
     * High-performance Myers Diff algorithm with O(prefix + suffix) common boundary trimming.
     * Operates in O(N * D) time where D is the edit distance.
     */
    fun computeDiffEdits(oldLines: List<String>, newLines: List<String>): List<DiffEdit> {
        val n = oldLines.size
        val m = newLines.size

        // 1. Common prefix trimming
        var prefix = 0
        while (prefix < n && prefix < m && oldLines[prefix] == newLines[prefix]) {
            prefix++
        }

        // 2. Common suffix trimming
        var suffix = 0
        while (suffix < (n - prefix) && suffix < (m - prefix) &&
            oldLines[n - 1 - suffix] == newLines[m - 1 - suffix]
        ) {
            suffix++
        }

        val edits = mutableListOf<DiffEdit>()

        // Add prefix edits (EQUAL)
        for (i in 0 until prefix) {
            edits.add(DiffEdit(EditType.EQUAL, i, i))
        }

        val midOldSize = n - prefix - suffix
        val midNewSize = m - prefix - suffix

        if (midOldSize > 0 || midNewSize > 0) {
            val middleEdits = if (midOldSize == 0) {
                // Pure insertion
                (0 until midNewSize).map { j ->
                    DiffEdit(EditType.INSERT, prefix, prefix + j)
                }
            } else if (midNewSize == 0) {
                // Pure deletion
                (0 until midOldSize).map { i ->
                    DiffEdit(EditType.DELETE, prefix + i, prefix)
                }
            } else {
                myersDiffSlice(
                    oldLines,
                    newLines,
                    prefix,
                    midOldSize,
                    midNewSize
                )
            }
            edits.addAll(middleEdits)
        }

        // Add suffix edits (EQUAL)
        for (s in 0 until suffix) {
            val oldIdx = n - suffix + s
            val newIdx = m - suffix + s
            edits.add(DiffEdit(EditType.EQUAL, oldIdx, newIdx))
        }

        return edits
    }

    private const val MAX_MYERS_EDIT_DISTANCE = 3500

    private fun myersDiffSlice(
        oldLines: List<String>,
        newLines: List<String>,
        prefix: Int,
        n: Int,
        m: Int
    ): List<DiffEdit> {
        val maxD = n + m
        if (maxD > MAX_MYERS_EDIT_DISTANCE * 2) {
            return fallbackReplacementSlice(prefix, n, m)
        }
        val vOffset = maxD
        val v = IntArray(2 * maxD + 1)
        v[vOffset + 1] = 0

        val trace = ArrayList<IntArray>()

        var foundD = -1
        for (d in 0..maxD.coerceAtMost(MAX_MYERS_EDIT_DISTANCE)) {
            val vCopy = v.clone()
            trace.add(vCopy)

            for (k in -d..d step 2) {
                var x: Int
                if (k == -d || (k != d && v[vOffset + k - 1] < v[vOffset + k + 1])) {
                    x = v[vOffset + k + 1]
                } else {
                    x = v[vOffset + k - 1] + 1
                }
                var y = x - k

                while (x < n && y < m && oldLines[prefix + x] == newLines[prefix + y]) {
                    x++
                    y++
                }

                v[vOffset + k] = x

                if (x >= n && y >= m) {
                    foundD = d
                    break
                }
            }
            if (foundD != -1) break
        }

        if (foundD == -1) {
            return fallbackReplacementSlice(prefix, n, m)
        }

        // Traceback from (n, m)
        val result = mutableListOf<DiffEdit>()
        var x = n
        var y = m

        for (d in trace.indices.reversed()) {
            val vSnapshot = trace[d]
            val k = x - y

            val prevK = if (k == -d || (k != d && vSnapshot[vOffset + k - 1] < vSnapshot[vOffset + k + 1])) {
                k + 1
            } else {
                k - 1
            }

            val prevX = vSnapshot[vOffset + prevK]
            val prevY = prevX - prevK

            // Snake (EQUAL elements)
            while (x > prevX && y > prevY && x > 0 && y > 0 &&
                (x - 1 < n && y - 1 < m) &&
                oldLines[prefix + x - 1] == newLines[prefix + y - 1]
            ) {
                result.add(DiffEdit(EditType.EQUAL, prefix + x - 1, prefix + y - 1))
                x--
                y--
            }

            if (d > 0) {
                if (x == prevX) {
                    // Vertical step: INSERT
                    result.add(DiffEdit(EditType.INSERT, prefix + x, prefix + y - 1))
                    y--
                } else {
                    // Horizontal step: DELETE
                    result.add(DiffEdit(EditType.DELETE, prefix + x - 1, prefix + y))
                    x--
                }
            }
        }

        // Snake before first edit (if any)
        while (x > 0 && y > 0) {
            result.add(DiffEdit(EditType.EQUAL, prefix + x - 1, prefix + y - 1))
            x--
            y--
        }

        result.reverse()
        return result
    }

    private fun fallbackReplacementSlice(prefix: Int, n: Int, m: Int): List<DiffEdit> {
        val result = ArrayList<DiffEdit>(n + m)
        for (i in 0 until n) {
            result.add(DiffEdit(EditType.DELETE, prefix + i, prefix))
        }
        for (j in 0 until m) {
            result.add(DiffEdit(EditType.INSERT, prefix + n, prefix + j))
        }
        return result
    }

    fun resolve(baseline: String, hunks: List<Hunk>, fallbackLineSep: String = "\n"): String {
        val lineSep = if (baseline.contains("\r\n")) "\r\n" else fallbackLineSep
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

        return resultLines.joinToString(lineSep)
    }

    fun resolveStaged(baseline: String, hunks: List<Hunk>, fallbackLineSep: String = "\n"): String {
        val lineSep = if (baseline.contains("\r\n")) "\r\n" else fallbackLineSep
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

        return resultLines.joinToString(lineSep)
    }
}
