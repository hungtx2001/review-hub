package com.reviewhub.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class FuzzyMatchUtilTest {

    @Test
    fun `exact match replaces correctly`() {
        val original = "val x = 10\nval y = 20"
        val replaced = FuzzyMatchUtil.findAndReplace(original, "val x = 10", "val x = 99")
        assertEquals("val x = 99\nval y = 20", replaced)
    }

    @Test
    fun `line ending agnostic match replaces CRLF vs LF`() {
        val original = "line 1\r\nline 2\r\nline 3"
        val oldStr = "line 2\nline 3"
        val newStr = "line 2 modified\nline 3"

        val replaced = FuzzyMatchUtil.findAndReplace(original, oldStr, newStr)
        assertNotNull(replaced)
        assertEquals("line 1\r\nline 2 modified\r\nline 3", replaced)
    }

    @Test
    fun `indentation tolerance matches 2 spaces vs 4 spaces`() {
        val original = "class Service {\n    fun execute() {\n        val result = true\n    }\n}"
        val oldWith2Spaces = "  fun execute() {\n    val result = true\n  }"
        val newContent = "    fun execute() {\n        val result = false\n        return result\n    }"

        val replaced = FuzzyMatchUtil.findAndReplace(original, oldWith2Spaces, newContent)
        assertNotNull(replaced)
        val expected = "class Service {\n    fun execute() {\n        val result = false\n        return result\n    }\n}"
        assertEquals(expected, replaced)
    }

    @Test
    fun `returns null when no match found`() {
        val original = "val a = 1\nval b = 2"
        val replaced = FuzzyMatchUtil.findAndReplace(original, "completely nonexistent string", "new")
        assertNull(replaced)
    }

    @Test
    fun `fuzzy line matching supports replaceAll`() {
        val original = "fun a() {\n    println(\"hi\")\n}\nfun b() {\n    println(\"hi\")\n}"
        val oldTrimmed = "  println(\"hi\")"
        val newContent = "  println(\"hello\")"

        val replaced = FuzzyMatchUtil.findAndReplace(original, oldTrimmed, newContent, replaceAll = true)
        assertNotNull(replaced)
        assertEquals("fun a() {\n    println(\"hello\")\n}\nfun b() {\n    println(\"hello\")\n}", replaced)
    }

    @Test
    fun `empty oldString only matches when text is empty to prevent overwriting existing files`() {
        assertNull(FuzzyMatchUtil.findAndReplace("existing content", "", "new content"))
        assertEquals("new content", FuzzyMatchUtil.findAndReplace("", "", "new content"))
    }
}

