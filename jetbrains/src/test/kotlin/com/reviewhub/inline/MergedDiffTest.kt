package com.reviewhub.inline

import com.reviewhub.model.Hunk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MergedDiffTest {

    @Test
    fun `builds interleaved deleted and added blocks for pending hunks`() {
        val baseline = "line 1\nold 2\nline 3\nold 4\nline 5"
        val hunks = listOf(
            Hunk(id = "h1", oldStart = 1, oldLines = listOf("old 2"), newStart = 1, newLines = listOf("new 2a", "new 2b"), decision = "pending"),
            Hunk(id = "h2", oldStart = 3, oldLines = listOf("old 4"), newStart = 4, newLines = listOf("new 4"), decision = "pending")
        )

        val view = MergedDiff.build(baseline, hunks)

        assertEquals(
            listOf("line 1", "old 2", "new 2a", "new 2b", "line 3", "old 4", "new 4", "line 5"),
            view.lines
        )
        val nonContext = view.blocks.filter { it.kind != MergedBlockKind.CONTEXT }
        assertEquals(4, nonContext.size)
    }

    @Test
    fun `ignores non-pending hunks in MergedDiff`() {
        val baseline = "line 1\nold 2\nline 3\nold 4\nline 5"
        val hunks = listOf(
            Hunk(id = "h1", oldStart = 1, oldLines = listOf("old 2"), newStart = 1, newLines = listOf("accepted 2a", "accepted 2b"), decision = "accepted"),
            Hunk(id = "h2", oldStart = 3, oldLines = listOf("old 4"), newStart = 4, newLines = listOf("pending 4"), decision = "pending")
        )

        val view = MergedDiff.build(baseline, hunks)
        val nonContext = view.blocks.filter { it.kind != MergedBlockKind.CONTEXT }
        assertEquals(2, nonContext.size)
        assertEquals(MergedBlockKind.DELETED, nonContext[0].kind)
        assertEquals("h2", nonContext[0].hunkId)
        assertEquals(MergedBlockKind.ADDED, nonContext[1].kind)
        assertEquals("h2", nonContext[1].hunkId)
    }

    @Test
    fun `handles empty baseline for newly created file`() {
        val baseline = ""
        val hunks = listOf(
            Hunk(id = "h1", oldStart = 0, oldLines = emptyList(), newStart = 0, newLines = listOf("first line", "second line"), decision = "pending")
        )

        val view = MergedDiff.build(baseline, hunks)
        assertEquals(listOf("first line", "second line"), view.lines)
    }
}
