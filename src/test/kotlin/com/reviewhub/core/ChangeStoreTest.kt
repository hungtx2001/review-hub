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
    fun `propose stages change in store`() {
        val wsDir = tempFolder.newFolder("my-project")
        val sampleFile = File(wsDir, "Hello.kt")
        sampleFile.writeText("fun main() {\n    println(\"old\")\n}")

        val store = ChangeStore()
        val changeSet = store.propose(wsDir.absolutePath, "Hello.kt", "fun main() {\n    println(\"new\")\n}")

        assertNotNull(changeSet)
        assertEquals("Hello.kt", changeSet.path)
        assertEquals(1, changeSet.hunks.size)
        assertEquals("pending", changeSet.status)

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

        // Verify disk content was updated
        assertEquals("val initial = 2", sampleFile.readText())

        // Verify store cleared active change
        val remaining = store.listChanges(wsDir.absolutePath)
        assertEquals(0, remaining.size)
    }

    @Test
    fun `reject restores baseline and removes change`() {
        val wsDir = tempFolder.newFolder("reject-project")
        val sampleFile = File(wsDir, "Reject.kt")
        sampleFile.writeText("original content")

        val store = ChangeStore()
        val cs = store.propose(wsDir.absolutePath, "Reject.kt", "unwanted content")

        val result = store.reject(changeId = cs.id, workspace = wsDir.absolutePath)
        assertNotNull(result)
        assertTrue(result!!.resolved)
        assertEquals("rejected", result.status)

        // Verify disk content stays baseline
        assertEquals("original content", sampleFile.readText())

        val remaining = store.listChanges(wsDir.absolutePath)
        assertEquals(0, remaining.size)
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
}

