(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
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
    b.addEventListener("click", onClick);
    return b;
  }

  function renderBar(s) {
    const bar = el("div", "bar");
    bar.appendChild(el("span", "name", s.name + (s.dir ? "  " + s.dir : "")));
    bar.appendChild(el("span", "stat", "+" + s.added + " \u2212" + s.removed));
    if (s.status === "resolved") bar.appendChild(el("span", "stat", "resolved"));
    bar.appendChild(el("span", "spacer"));
    bar.appendChild(button("\u2713 Accept All", "Accept every hunk", function () {
      send("acceptFile", { changeId: s.changeId });
    }));
    bar.appendChild(button("\u21ba Discard All", "Reject every hunk", function () {
      send("rejectFile", { changeId: s.changeId });
    }));
    return bar;
  }

  function scrollToHunk(hunkId) {
    if (!hunkId) return;
    const target = document.getElementById("hunk-" + hunkId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("hunk-highlight");
      setTimeout(function () {
        target.classList.remove("hunk-highlight");
      }, 1500);
    }
  }

  function renderHunkBar(s, hunk) {
    const bar = el("div", "hunkbar");
    bar.id = "hunk-" + hunk.id;
    bar.appendChild(el("span", "stat", "+" + hunk.added + " \u2212" + hunk.removed));
    bar.appendChild(el("span", "spacer"));
    if (hunk.decision === "accepted") {
      bar.appendChild(el("span", "badge ok", "\u2713 accepted"));
      bar.appendChild(button("\u21ba Undo", "Undo — restore baseline lines", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else if (hunk.decision === "rejected") {
      bar.appendChild(el("span", "badge no", "\u2717 rejected"));
      bar.appendChild(button("\u2713 Undo", "Undo — keep proposed lines", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else {
      bar.appendChild(button("\u2713 Accept", "Keep this hunk's new lines", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
      bar.appendChild(button("\u21ba Reject", "Restore this hunk's baseline lines", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    }
    return bar;
  }

  function render(next, targetHunkId) {
    const prevScroll = window.scrollY || document.documentElement.scrollTop || 0;
    state = next;
    root.textContent = "";
    root.appendChild(renderBar(next));
    if (next.binary) {
      root.appendChild(el("div", "line", "(binary file — accept or reject the whole file from the Review Hub panel)"));
      return;
    }
    const byLine = new Map();
    for (const hunk of next.hunks) byLine.set(hunk.line, hunk);
    for (let i = 0; i < next.lines.length; i++) {
      const hunk = byLine.get(i);
      if (hunk) root.appendChild(renderHunkBar(next, hunk));
      const line = next.lines[i];
      const row = el("div", "line " + line.kind);
      row.appendChild(el("span", "gutter", String(i + 1)));
      row.appendChild(el("span", "text", line.text === "" ? " " : line.text));
      root.appendChild(row);
    }
    if (targetHunkId) {
      scrollToHunk(targetHunkId);
    } else {
      window.scrollTo(0, prevScroll);
    }
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") {
      render(msg.state, msg.targetHunkId);
    } else if (msg && msg.type === "scrollToHunk") {
      scrollToHunk(msg.hunkId);
    }
  });

  send("ready");
})();
