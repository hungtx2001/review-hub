/**
 * Minimal VS Code surface for tests. Extends the dsh stub with the APIs Review Hub
 * uses: TreeView, FileSystemWatcher, TextDocumentContentProvider, CodeLens, tabGroups.
 */
function envJson(name: string): Record<string, unknown> {
  try {
    const raw = process.env[name];
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const log: string[] = [];
const messages: string[] = [];
const commands = new Map<string, ((...args: never[]) => unknown)[]>();
const contentProviders = new Map<string, unknown>();
const webviews = new Map<string, unknown>();

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(value: T): void {
    for (const l of this.listeners) {
      l(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

class ThemeIcon {
  constructor(readonly id: string) {}
}

class TreeItem {
  label: string;
  collapsibleState?: number;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  resourceUri?: unknown;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const panels: unknown[] = [];

function makeFakeWebview() {
  const listeners: ((msg: unknown) => void)[] = [];
  const posted: unknown[] = [];
  return {
    html: "",
    options: {} as unknown,
    cspSource: "vscode-resource://test",
    asWebviewUri: (uri: { toString(): string }) => uri,
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      listeners.push(cb);
      return { dispose: () => {} };
    },
    postMessage: async (msg: unknown) => {
      posted.push(msg);
      return true;
    },
    /** Test hook: every message the provider posted, in order. */
    posted,
    __receive: (msg: unknown) => listeners.forEach((cb) => cb(msg)),
  };
}

const stub = {
  __log: log,
  __messages: messages,
  __commands: commands,
  __contentProviders: contentProviders,
  __webviews: webviews,
  __panels: panels,
  /** Test hook: the documents `window.visibleTextEditors` should report. */
  __visibleEditors: [] as unknown[],
  /** Test hook: documents reported by `workspace.textDocuments`. */
  __textDocuments: [] as unknown[],
  /** Test hook: every workspace listener registered, tagged with its event name. */
  __listeners: [] as { event: string; cb: (...args: never[]) => unknown }[],
  /** Test hook: every decoration type created, with the options it was created with. */
  __decorationTypes: [] as { id: number; opts: Record<string, unknown> }[],
  /** Test hook: every `commands.executeCommand` invocation, in order. */
  __executed: [] as { command: string; args: unknown[] }[],
  WorkspaceEdit: class {
    readonly edits: { uri: unknown; text: string }[] = [];
    replace(uri: unknown, _range: unknown, text: string): void {
      this.edits.push({ uri, text });
    }
    insert(uri: unknown, _pos: unknown, text: string): void {
      this.edits.push({ uri, text });
    }
    delete(_uri: unknown, _range: unknown): void {}
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  TextEdit: class TextEdit {
    constructor(readonly range: unknown, readonly newText: string) {}
    static replace(range: unknown, newText: string) {
      return new TextEdit(range, newText);
    }
  },
  MarkdownString: class {
    value: string;
    isTrusted = false;
    constructor(value = "") {
      this.value = value;
    }
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
    appendCodeblock(code: string) {
      this.value += "```\n" + code + "\n```";
      return this;
    }
  },
  EventEmitter,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CodeLens: class {
    constructor(readonly range: unknown, readonly command?: unknown) {}
  },
  Range: class {
    constructor(readonly startLine: number, readonly startChar: number, readonly endLine: number, readonly endChar: number) {}
  },
  Position: class {
    constructor(readonly line: number, readonly character: number) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => log.push(line),
      show: () => {},
      dispose: () => {},
    }),
    showErrorMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showInformationMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      messages.push(message);
      return undefined;
    },
    showQuickPick: async (items: unknown) => items,
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      command: "",
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    createTextEditorDecorationType: (opts: Record<string, unknown> = {}) => {
      const type = { id: stub.__decorationTypes.length, opts, dispose: () => {} };
      stub.__decorationTypes.push(type);
      return type;
    },
    get visibleTextEditors() {
      return stub.__visibleEditors;
    },
    showTextDocument: async (doc: unknown) => ({ document: doc, setDecorations: () => {} }),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose: () => {} }),
    onDidChangeWindowState: () => ({ dispose: () => {} }),
    get state() {
      return { focused: true };
    },
    createTreeView: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      const fake = {
        viewType: id,
        visible: true,
        title: "Changes",
        show: () => {},
        onDidChangeVisibility: () => ({ dispose: () => {} }),
        webview: makeFakeWebview(),
      };
      (provider as { resolveWebviewView(view: unknown): void }).resolveWebviewView(fake);
      webviews.set(id, fake);
      return { dispose: () => webviews.delete(id) };
    },
    createWebviewPanel: (id: string, title: string, _column: unknown, _options: unknown) => {
      const listeners: ((msg: unknown) => void)[] = [];
      const posted: unknown[] = [];
      const panel = {
        viewType: id,
        title,
        posted,
        webview: {
          html: "",
          options: {} as unknown,
          cspSource: "vscode-resource://test",
          asWebviewUri: (uri: { toString(): string }) => uri,
          onDidReceiveMessage: (cb: (msg: unknown) => void) => {
            listeners.push(cb);
            return { dispose: () => {} };
          },
          postMessage: async (msg: unknown) => {
            posted.push(msg);
            return true;
          },
          /** Test hook: pretend the webview sent this message. */
          __receive: (msg: unknown) => listeners.forEach((cb) => cb(msg)),
        },
        onDidDispose: (cb: () => void) => {
          (panel as { __dispose?: () => void }).__dispose = cb;
          return { dispose: () => {} };
        },
        reveal: () => {},
        dispose: () => (panel as { __dispose?: () => void }).__dispose?.(),
      };
      panels.push(panel);
      return panel;
    },
    registerFileDecorationProvider: () => ({ dispose: () => {} }),
    get activeTextEditor() {
      return undefined;
    },
    get tabGroups() {
      return { all: [], close: async () => true };
    },
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  commands: {
    registerCommand: (id: string, cb: (...args: never[]) => unknown) => {
      const handlers = commands.get(id) ?? [];
      handlers.push(cb);
      commands.set(id, handlers);
      return {
        dispose: () => {
          commands.set(id, (commands.get(id) ?? []).filter((handler) => handler !== cb));
        },
      };
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
      stub.__executed.push({ command, args });
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => {
      const config = envJson("VSCODE_STUB_CONFIG");
      return {
        get: <T>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
        update: async (): Promise<void> => {},
      };
    },
    get textDocuments() {
      return stub.__textDocuments;
    },
    get workspaceFolders() {
      const folders = envJson("VSCODE_STUB_WORKSPACE");
      return Array.isArray(folders) ? folders : [];
    },
    getWorkspaceFolder: (uri: { fsPath: string }) => {
      const folders = stub.workspace.workspaceFolders as { uri: { fsPath: string } }[];
      return folders.find((folder) => folder.uri.fsPath === uri.fsPath) ?? folders[0];
    },
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      contentProviders.set(scheme, provider);
      return { dispose: () => contentProviders.delete(scheme) };
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    onDidChangeTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "change", cb });
      return { dispose: () => {} };
    },
    onWillSaveTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "willSave", cb });
      return { dispose: () => {} };
    },
    onDidOpenTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "open", cb });
      return { dispose: () => {} };
    },
    onDidCloseTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "close", cb });
      return { dispose: () => {} };
    },
    openTextDocument: async (uri: unknown) => ({
      uri,
      isDirty: false,
      lineCount: 1,
      lineAt: () => ({ range: {} }),
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      getText: () => "",
    }),
    applyEdit: async () => true,
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
    },
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
  },
  env: {
    asExternalUri: async (uri: { toString(): string }) => uri,
    openExternal: async () => true,
    clipboard: { writeText: async () => {}, readText: async () => "" },
  },
  Uri: {
    parse: (value: string) => ({
      scheme: value.split(":")[0] ?? "",
      authority: value.includes("://") ? value.split("://")[1].split("/")[0] : "",
      path: value.includes("://") ? "/" + value.split("://")[1].split("/").slice(1).join("/") : value,
      toString: () => value,
      fsPath: value.replace(/^\/?\/?/, ""),
    }),
    file: (value: string) => ({
      scheme: "file",
      authority: "",
      path: value,
      fsPath: value,
      toString: () => `file://${value}`,
    }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      scheme: "file",
      path: [base.fsPath, ...parts].join("/"),
      fsPath: [base.fsPath, ...parts].join("/"),
      toString: () => `file://${[base.fsPath, ...parts].join("/")}`,
    }),
  },
  ViewColumn: { Active: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
};

export = stub;
