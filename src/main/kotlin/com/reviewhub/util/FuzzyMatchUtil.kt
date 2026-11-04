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

        val newLinesRaw = newString.replace("\r\n", "\n").split("\n")
        val matchIndices = findMatchingLineWindows(textLines, oldTrimmed, replaceAll)
        if (matchIndices.isNotEmpty()) {
            val resultLines = mutableListOf<String>()
            var currentIdx = 0
            val oldFirstIndent = oldLines.firstOrNull { it.isNotBlank() }?.takeWhile { it == ' ' || it == '\t' } ?: ""
            val newFirstIndent = newLinesRaw.firstOrNull { it.isNotBlank() }?.takeWhile { it == ' ' || it == '\t' } ?: ""

            for (matchIndex in matchIndices) {
                if (matchIndex > currentIdx) {
                    resultLines.addAll(textLines.subList(currentIdx, matchIndex))
                }
                val targetFirstIndent = textLines.subList(matchIndex, matchIndex + oldLines.size)
                    .firstOrNull { it.isNotBlank() }
                    ?.takeWhile { it == ' ' || it == '\t' } ?: ""

                val adjustedNewLines = if (oldFirstIndent == newFirstIndent && targetFirstIndent != oldFirstIndent) {
                    newLinesRaw.map { line ->
                        if (line.isBlank()) line
                        else if (line.startsWith(oldFirstIndent)) targetFirstIndent + line.substring(oldFirstIndent.length)
                        else line
                    }
                } else {
                    newLinesRaw
                }

                resultLines.addAll(adjustedNewLines)
                currentIdx = matchIndex + oldLines.size
            }
            if (currentIdx < textLines.size) {
                resultLines.addAll(textLines.subList(currentIdx, textLines.size))
            }

            val combined = resultLines.joinToString("\n")
            return if (isWindows) combined.replace("\n", "\r\n") else combined
        }

        return null
    }

    private fun findMatchingLineWindows(
        textLines: List<String>,
        oldTrimmed: List<String>,
        replaceAll: Boolean
    ): List<Int> {
        val windowSize = oldTrimmed.size
        val matches = mutableListOf<Int>()
        var i = 0
        while (i <= textLines.size - windowSize) {
            var matched = true
            for (j in 0 until windowSize) {
                if (textLines[i + j].trim() != oldTrimmed[j]) {
                    matched = false
                    break
                }
            }
            if (matched) {
                matches.add(i)
                if (!replaceAll) break
                i += windowSize
            } else {
                i++
            }
        }
        return matches
    }
}

