package com.reviewhub.actions

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class OpenWebsiteAction : AnAction("Open Review Hub Website") {
    override fun actionPerformed(e: AnActionEvent) {
        BrowserUtil.browse("https://hungtx2001.github.io/review-hub/")
    }
}

