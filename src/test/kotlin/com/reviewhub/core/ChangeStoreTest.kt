package com.reviewhub.core

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ChangeStoreTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun `propose stages change in store and live-syncs to disk for build and test`() {
        val wsDir = tempFolder.newFolder("my-project")
        val sampleFile = File(wsDir, "Hello.kt")
        sampleFile.writeText("fun main() {\n    println(\"old\")\n}")

        val store = ChangeStore()
        val changeSet = store.propose(wsDir.absolutePath, "Hello.kt", "fun main() {\n    println(\"new\")\n}")

        assertNotNull(changeSet)
        assertEquals("Hello.kt", changeSet.path)
        assertEquals(1, changeSet.hunks.size)
        assertEquals("pending", changeSet.status)

        // Disk immediately has the proposed content so compilers/test runners see new code
        assertEquals("fun main() {\n    println(\"new\")\n}", sampleFile.readText())
        // Baseline is safely preserved in ChangeSet
        assertEquals("fun main() {\n    println(\"old\")\n}", changeSet.baseline)

        val list = store.listChanges(wsDir.absolutePath)
        assertEquals(1, list.size)
        assertEquals(1, list[0].pending)
    }

    @Test
    fun `accept applies change to disk and clears change`() {
        val wsDir = tempFolder.newFolder("accept-project")
        val sampleFile = File(wsDir, "Test.kt")
        sampleFile.writeText("val initial = 1")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "Test.kt", "val initial = 2")

        val result = store.accept(changeId = cs.id, workspace = wsDir.absolutePath)
        assertNotNull(result)
        assertTrue(result!!.resolved)
        assertEquals("applied", result.status)

        // Verify disk content is updated
        assertEquals("val initial = 2", sampleFile.readText())

        // Verify store cleared active change
        val remaining = store.listChanges(wsDir.absolutePath)
        assertEquals(0, remaining.size)
    }

    @Test
    fun `reject restores baseline on disk and removes change`() {
        val wsDir = tempFolder.newFolder("reject-project")
        val sampleFile = File(wsDir, "Reject.kt")
        sampleFile.writeText("original content")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "Reject.kt", "unwanted content")
        // While pending, disk has live-synced proposed content for AI build/test
        assertEquals("unwanted content", sampleFile.readText())

        val result = store.reject(changeId = cs.id, workspace = wsDir.absolutePath)
        assertNotNull(result)
        assertTrue(result!!.resolved)
        assertEquals("rejected", result.status)

        // Verify disk content is immediately restored to baseline upon reject
        assertEquals("original content", sampleFile.readText())

        val remaining = store.listChanges(wsDir.absolutePath)
        assertEquals(0, remaining.size)
    }

    @Test
    fun `rejecting newly created file deletes it from disk`() {
        val wsDir = tempFolder.newFolder("reject-new-file")
        val newFile = File(wsDir, "BrandNew.kt")
        assertFalse(newFile.exists())

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "BrandNew.kt", "class BrandNew")
        // Live-synced on disk so AI compiler can compile BrandNew.kt
        assertTrue(newFile.exists())
        assertEquals("class BrandNew", newFile.readText())

        // Rejecting the new file removes it from disk
        val res = store.reject(changeId = cs.id, workspace = wsDir.absolutePath)
        assertNotNull(res)
        assertTrue(res!!.resolved)
        assertFalse("Rejected newly created file must be deleted from disk", newFile.exists())
    }

    @Test
    fun `persists and reloads staging across store instances`() {
        val wsDir = tempFolder.newFolder("persist-project")
        val sampleFile = File(wsDir, "Persist.kt")
        sampleFile.writeText("line 1\nline 2")

        val store1 = ChangeStore()
        val cs = store1.propose(wsDir.absolutePath, "Persist.kt", "line 1\nline 2 modified")
        assertEquals(1, store1.listChanges(wsDir.absolutePath).size)

        // Create a new store instance (simulating IDE restart)
        val store2 = ChangeStore()
        val restoredList = store2.listChanges(wsDir.absolutePath)
        assertEquals(1, restoredList.size)
        assertEquals("Persist.kt", restoredList[0].path)

        // Clean up by rejecting
        store2.reject(changeId = cs.id, workspace = wsDir.absolutePath)
        assertEquals(0, store2.listChanges(wsDir.absolutePath).size)
        assertEquals("line 1\nline 2", sampleFile.readText())
    }

    @Test
    fun `rollbackToCheckpoint restores disk to baseline and deletes new files`() {
        val wsDir = tempFolder.newFolder("rollback-project")
        val oldFile = File(wsDir, "Old.kt")
        oldFile.writeText("val a = 1")

        val store = ChangeStore()
        val cs1 = store.propose(wsDir.absolutePath, "Old.kt", "val a = 999")
        val cs2 = store.propose(wsDir.absolutePath, "New.kt", "fun brandNew() {}")

        // Accept both to disk
        store.accept(changeId = cs1.id, workspace = wsDir.absolutePath)
        store.accept(changeId = cs2.id, workspace = wsDir.absolutePath)

        assertEquals("val a = 999", oldFile.readText())
        val newFile = File(wsDir, "New.kt")
        assertTrue(newFile.exists())

        // Perform rollback
        val reverted = store.rollbackToCheckpoint(wsDir.absolutePath)
        assertTrue(reverted.contains("Old.kt"))
        assertTrue(reverted.contains("New.kt"))

        // Verify old file is reverted to original baseline
        assertEquals("val a = 1", oldFile.readText())

        // Verify newly created file is deleted
        assertFalse(newFile.exists())

        // Verify staging is empty
        assertEquals(0, store.listChanges(wsDir.absolutePath).size)
    }

    @Test
    fun `getReviewStatus returns accurate hunk counts and statuses`() {
        val wsDir = tempFolder.newFolder("status-project")
        val file = File(wsDir, "Status.kt")
        file.writeText("line1\nline2")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "Status.kt", "line1 modified\nline2")

        val statusBefore = store.getReviewStatus(wsDir.absolutePath, path = "Status.kt")
        assertEquals("pending", statusBefore.status)
        assertEquals(1, statusBefore.pendingHunks)
        assertEquals(0, statusBefore.acceptedHunks)

        store.accept(changeId = cs.id, workspace = wsDir.absolutePath)

        val wsStatusAfter = store.getReviewStatus(wsDir.absolutePath)
        assertEquals("idle", wsStatusAfter.status)
        assertEquals(0, wsStatusAfter.pendingHunks)
    }

    @Test
    fun `accept with customContent saves user tweaked content to disk`() {
        val wsDir = tempFolder.newFolder("tweak-project")
        val file = File(wsDir, "Tweak.kt")
        file.writeText("fun calc() = 1")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "Tweak.kt", "fun calc() = 2")

        // User tweaked the content before accepting: "fun calc() = 100 // edited by human"
        val customText = "fun calc() = 100 // edited by human"
        val result = store.accept(changeId = cs.id, workspace = wsDir.absolutePath, customContent = customText)

        assertNotNull(result)
        assertTrue(result!!.resolved)
        assertEquals(customText, file.readText())
    }

    @Test
    fun `propose delete removes file on disk immediately and restores on reject`() {
        val wsDir = tempFolder.newFolder("delete-project")
        val file1 = File(wsDir, "DeleteMe.kt")
        file1.writeText("class DeleteMe")
        val file2 = File(wsDir, "KeepMe.kt")
        file2.writeText("class KeepMe")

        val store = ChangeStore()
        val cs1 = store.propose(wsDir.absolutePath, "DeleteMe.kt", "", proposedExists = false)
        val cs2 = store.propose(wsDir.absolutePath, "KeepMe.kt", "", proposedExists = false)

        assertEquals("", store.readFile(wsDir.absolutePath, "DeleteMe.kt"))
        // Deleted immediately on disk so AI builds test without the deleted file
        assertFalse(file1.exists())
        assertFalse(file2.exists())

        // Accept deletion of DeleteMe.kt
        val res1 = store.accept(changeId = cs1.id, workspace = wsDir.absolutePath)
        assertNotNull(res1)
        assertTrue(res1!!.resolved)
        assertFalse("Accepted deletion must keep file deleted from disk", file1.exists())

        // Reject deletion of KeepMe.kt -> immediately restores file on disk from baseline snapshot!
        val res2 = store.reject(changeId = cs2.id, workspace = wsDir.absolutePath)
        assertNotNull(res2)
        assertTrue(res2!!.resolved)
        assertTrue("Rejected deletion must restore file on disk", file2.exists())
        assertEquals("class KeepMe", file2.readText())
    }

    @Test
    fun `subsequent propose preserves already decided partial hunks`() {
        val wsDir = tempFolder.newFolder("partial-project")
        val file = File(wsDir, "Partial.kt")
        file.writeText("line 1\nline 2\nline 3\nline 4\nline 5")

        val store = ChangeStore()
        // Propose modifying line 1 and line 5 (2 disjoint hunks)
        val cs1 = store.propose(wsDir.absolutePath, "Partial.kt", "line 1 accepted\nline 2\nline 3\nline 4\nline 5 pending")
        assertEquals(2, cs1.hunks.size)

        // User accepts hunk-1 only
        val firstHunkId = cs1.hunks[0].id
        store.accept(changeId = cs1.id, workspace = wsDir.absolutePath, hunkIds = listOf(firstHunkId))

        // Now AI proposes another edit on top of staged state
        val cs2 = store.propose(wsDir.absolutePath, "Partial.kt", "line 1 accepted\nline 2\nline 3\nline 4\nline 5 modified again")
        // Hunk 1 was already accepted so baseline now includes "line 1 accepted"; only 1 pending hunk should remain
        assertEquals(1, cs2.hunks.size)
        assertEquals(listOf("line 5"), cs2.hunks[0].oldLines)
        assertEquals(listOf("line 5 modified again"), cs2.hunks[0].newLines)
    }

    @Test
    fun `partial hunk rejection immediately updates disk content`() {
        val wsDir = tempFolder.newFolder("partial-reject-project")
        val file = File(wsDir, "PartialReject.kt")
        file.writeText("line 1\nline 2\nline 3\nline 4\nline 5")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "PartialReject.kt", "line 1 bad\nline 2\nline 3\nline 4\nline 5 good")
        assertEquals(2, cs.hunks.size)
        assertEquals("line 1 bad\nline 2\nline 3\nline 4\nline 5 good", file.readText())

        // Reject first hunk only ("line 1 bad" -> reverts to "line 1") while second hunk remains pending
        val firstHunkId = cs.hunks[0].id
        val res = store.reject(changeId = cs.id, workspace = wsDir.absolutePath, hunkIds = listOf(firstHunkId))
        assertNotNull(res)
        assertFalse(res!!.resolved)
        assertEquals(1, res.remaining)

        // Disk immediately has hunk-1 reverted and hunk-2 still active
        assertEquals("line 1\nline 2\nline 3\nline 4\nline 5 good", file.readText())
    }
}
