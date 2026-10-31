package com.reviewhub.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.reviewhub.hub.HubManager

class RefreshAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val hubManager = project.getService(HubManager::class.java)
        ApplicationManager.getApplication().executeOnPooledThread {
            if (hubManager.client == null) {
                hubManager.connect()
            } else {
                hubManager.refresh()
            }
        }
    }
}
