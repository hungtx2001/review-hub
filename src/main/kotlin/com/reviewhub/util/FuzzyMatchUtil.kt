package com.reviewhub.util

object FuzzyMatchUtil {

    /**
     * Finds oldString in text and replaces with newString.
     * Supports exact match, line-ending agnostic match (\r\n vs \n),
     * and indentation/whitespace tolerance matching.
     * Returns the replaced text, or null if no match was found.
     */
    fun findAndReplace(
        text: String,
        oldString: String,
        newString: String,
        replaceAll: Boolean = false
    ): String? {
        if (oldString.isEmpty()) {
            return newString
        }

        // 1. Exact match
        if (text.contains(oldString)) {
            return if (replaceAll) {
                text.replace(oldString, newString)
            } else {
                text.replaceFirst(oldString, newString)
            }
        }

        // 2. Line ending normalization match (\r\n vs \n)
        val isWindows = text.contains("\r\n")
        val normalizedOld = oldString.replace("\r\n", "\n")
        val normalizedText = text.replace("\r\n", "\n")

        if (normalizedText.contains(normalizedOld)) {
            val normalizedNew = newString.replace("\r\n", "\n")
            val replacedNorm = if (replaceAll) {
                normalizedText.replace(normalizedOld, normalizedNew)
            } else {
                normalizedText.replaceFirst(normalizedOld, normalizedNew)
            }
            return if (isWindows) replacedNorm.replace("\n", "\r\n") else replacedNorm
        }

        // 3. Line-based trimmed / indentation fuzzy matching
        val textLines = normalizedText.split("\n")
        val oldLines = normalizedOld.split("\n")
        val oldTrimmed = oldLines.map { it.trim() }

        if (oldTrimmed.isEmpty() || oldTrimmed.size > textLines.size) return null

        val matchIndex = findMatchingLineWindow(textLines, oldTrimmed)
        if (matchIndex >= 0) {
            val beforeLines = textLines.subList(0, matchIndex)
            val afterLines = textLines.subList(matchIndex + oldLines.size, textLines.size)

            val newLines = newString.replace("\r\n", "\n").split("\n")

            val combined = (beforeLines + newLines + afterLines).joinToString("\n")
            return if (isWindows) combined.replace("\n", "\r\n") else combined
        }

        return null
    }

    private fun findMatchingLineWindow(textLines: List<String>, oldTrimmed: List<String>): Int {
        val windowSize = oldTrimmed.size
        for (i in 0..(textLines.size - windowSize)) {
            var matched = true
            for (j in 0 until windowSize) {
                if (textLines[i + j].trim() != oldTrimmed[j]) {
                    matched = false
                    break
                }
            }
            if (matched) return i
        }
        return -1
    }
}

