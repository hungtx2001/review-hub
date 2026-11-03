package com.reviewhub.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PathUtilTest {
    @Test
    fun `normalizes Windows and POSIX workspace paths case-insensitively`() {
        assertEquals(
            "src/main/App.kt",
            PathUtil.toRelativePath("D:\\Project\\hub-preview", "d:/Project/hub-preview/src/main/App.kt")
        )
        assertEquals(
            "DEMO_REVIEW.md",
            PathUtil.toRelativePath("D:/Project/hub-preview/", "D:\\Project\\hub-preview\\DEMO_REVIEW.md")
        )
        assertNull(
            PathUtil.toRelativePath("D:/Project/hub-preview", "D:/Project/other-repo/file.txt")
        )
    }
}

