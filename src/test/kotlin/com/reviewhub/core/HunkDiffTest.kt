package com.reviewhub.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HunkDiffTest {

    @Test
    fun `computeHunks returns empty list for identical content`() {
        val content = "line 1\nline 2\nline 3"
        val hunks = HunkDiff.computeHunks(content, content)
        assertTrue(hunks.isEmpty())
    }

    @Test
    fun `computeHunks detects single line insertion`() {
        val base = "fun hello() {\n    println(\"hello\")\n}"
        val prop = "fun hello() {\n    val greeting = \"hello\"\n    println(greeting)\n}"

        val hunks = HunkDiff.computeHunks(base, prop)
        assertEquals(1, hunks.size)
        assertEquals("hunk-1", hunks[0].id)
        assertEquals(1, hunks[0].oldStart)
        assertEquals(listOf("    println(\"hello\")"), hunks[0].oldLines)
        assertEquals(listOf("    val greeting = \"hello\"", "    println(greeting)"), hunks[0].newLines)
    }

    @Test
    fun `computeHunks detects multiple disjoint hunks`() {
        val base = "val a = 1\nval b = 2\nval c = 3\nval d = 4\nval e = 5"
        val prop = "val a = 10\nval b = 2\nval c = 3\nval d = 40\nval e = 5"

        val hunks = HunkDiff.computeHunks(base, prop)
        assertEquals(2, hunks.size)
        assertEquals("hunk-1", hunks[0].id)
        assertEquals(0, hunks[0].oldStart)
        assertEquals(listOf("val a = 1"), hunks[0].oldLines)
        assertEquals(listOf("val a = 10"), hunks[0].newLines)

        assertEquals("hunk-2", hunks[1].id)
        assertEquals(3, hunks[1].oldStart)
        assertEquals(listOf("val d = 4"), hunks[1].oldLines)
        assertEquals(listOf("val d = 40"), hunks[1].newLines)
    }

    @Test
    fun `computeHunks handles large files with high performance`() {
        // 3,000 lines with 2 modifications
        val baseLines = (1..3000).map { "line $it" }
        val propLines = baseLines.toMutableList()
        propLines[500] = "modified line 501"
        propLines[2500] = "modified line 2501"

        val startTime = System.currentTimeMillis()
        val hunks = HunkDiff.computeHunks(baseLines.joinToString("\n"), propLines.joinToString("\n"))
        val elapsed = System.currentTimeMillis() - startTime

        assertEquals(2, hunks.size)
        assertTrue("Myers diff with boundary trimming should complete in < 200ms, took ${elapsed}ms", elapsed < 200)
    }

    @Test
    fun `resolve correctly applies accepted and rejected hunks`() {
        val base = "line 1\nline 2\nline 3\nline 4"
        val prop = "line 1\nmodified 2\nline 3\nmodified 4"

        val hunks = HunkDiff.computeHunks(base, prop)
        assertEquals(2, hunks.size)

        // Accept first hunk, reject second hunk
        val decidedHunks = listOf(
            hunks[0].copy(decision = "accepted"),
            hunks[1].copy(decision = "rejected")
        )

        val resolved = HunkDiff.resolve(base, decidedHunks)
        assertEquals("line 1\nmodified 2\nline 3\nline 4", resolved)
    }
}

