(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const expanded = new Set();
  let state = null;

  function send(command, payload) {
    vscode.postMessage(Object.assign({ command: command }, payload || {}));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, onClick) {
    const b = el("button", "btn", label);
    b.title = title;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function renderHunk(file, hunk) {
    const row = el("div", "hunk hunk-" + hunk.decision);
    row.appendChild(el("span", "line", "@line " + hunk.anchorLine));
    row.appendChild(el("span", "stat", "+" + hunk.added + " \u2212" + hunk.removed));
    row.appendChild(el("span", "spacer"));
    if (hunk.decision === "accepted") {
      row.appendChild(el("span", "badge ok", "\u2713 accepted"));
      row.appendChild(button("\u21ba", "Undo — reject this hunk", function () {
        send("rejectHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    } else if (hunk.decision === "rejected") {
      row.appendChild(el("span", "badge no", "\u2717 rejected"));
      row.appendChild(button("\u2713", "Undo — accept this hunk", function () {
        send("acceptHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    } else {
      row.appendChild(button("\u2713", "Accept this hunk", function () {
        send("acceptHunk", { changeId: file.id, hunkId: hunk.id });
      }));
      row.appendChild(button("\u21ba", "Reject this hunk", function () {
        send("rejectHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    }
    row.addEventListener("click", function () {
      send("openHunk", { changeId: file.id, hunkId: hunk.id });
    });
    return row;
  }

  function renderFile(file) {
    const wrap = el("div", "file");
    const head = el("div", "file-head");
    const open = expanded.has(file.id);
    const twisty = el("span", "twisty", open ? "\u25be" : "\u25b8");
    twisty.addEventListener("click", function (e) {
      e.stopPropagation();
      if (expanded.has(file.id)) expanded.delete(file.id);
      else expanded.add(file.id);
      render(state);
    });
    head.appendChild(twisty);
    head.appendChild(el("span", "name", file.name));
    if (file.dir) head.appendChild(el("span", "dir", file.dir));
    if (file.isNew) head.appendChild(el("span", "badge ok", "new"));
    if (file.isDeleted) head.appendChild(el("span", "badge no", "deleted"));
    if (file.binary) head.appendChild(el("span", "badge", "binary"));
    head.appendChild(el("span", "spacer"));
    head.appendChild(el("span", "stat", "+" + file.added + " \u2212" + file.removed));
    head.appendChild(button("\u2713", "Accept every hunk in this file", function () {
      send("acceptFile", { changeId: file.id });
    }));
    head.appendChild(button("\u21ba", "Reject every hunk in this file", function () {
      send("rejectFile", { changeId: file.id });
    }));
    head.addEventListener("click", function () {
      send("openDiff", { changeId: file.id });
    });
    wrap.appendChild(head);
    if (open) {
      for (const hunk of file.hunks) wrap.appendChild(renderHunk(file, hunk));
    }
    return wrap;
  }

  function render(next) {
    const prevScroll = window.scrollY || document.documentElement.scrollTop || 0;
    state = next;
    root.textContent = "";

    const header = el("div", "header");
    header.appendChild(el("span", "count", next.totalFiles + (next.totalFiles === 1 ? " file" : " files")));
    header.appendChild(el("span", "spacer"));
    header.appendChild(el("span", "stat add", "+" + next.added));
    header.appendChild(el("span", "stat del", "\u2212" + next.removed));
    root.appendChild(header);

    if (next.totalFiles === 0) {
      const actions = el("div", "actions");
      actions.appendChild(button("\u27f3 Checkpoint", "Set a new checkpoint (accept the current state)", function () {
        send("setCheckpoint");
      }));
      root.appendChild(actions);

      const cp = next.checkpoint
        ? "Checkpoint: " + next.checkpoint.files + " files"
        : "No checkpoint set — changes are measured from now.";
      root.appendChild(el("div", "empty", "No changes to review. " + cp));
      return;
    }

    const actions = el("div", "actions");
    actions.appendChild(button("\u2713 Accept All", "Accept every change in every project", function () {
      send("acceptAll");
    }));
    actions.appendChild(button("\u21ba Discard All", "Reject every change in every project", function () {
      send("rejectAll");
    }));
    actions.appendChild(button("\u27f3 Checkpoint", "Set a new checkpoint (accept the current state)", function () {
      send("setCheckpoint");
    }));
    root.appendChild(actions);

    for (const group of next.groups) {
      if (next.groups.length > 1) root.appendChild(el("div", "group", group.label));
      for (const file of group.files) root.appendChild(renderFile(file));
    }
    window.scrollTo(0, prevScroll);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });

  send("ready");
})();
