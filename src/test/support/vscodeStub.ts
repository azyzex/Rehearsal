/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Enough of the VS Code API to start the extension.
 *
 * `activate()` is the one function nothing could reach. It is not called by any
 * test, it cannot be imported without a `vscode` module to resolve, and if it
 * throws, the entire extension does nothing at all — no icon, no commands, no
 * message. The user's report for that is "I clicked the thing and nothing
 * happened", which is indistinguishable from every other bug in this project.
 *
 * This is deliberately not a mock framework. Each member is the smallest thing
 * that behaves plausibly, and every call is recorded so a test can ask what
 * activation actually did.
 */

/** One webview panel the extension opened, and everything it sent to it. */
export interface RecordedPanel {
  readonly viewType: string;
  readonly title: string;
  readonly posted: Record<string, unknown>[];
}

export interface Recorded {
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  /** Every panel opened, in the order they were opened. */
  readonly panels: RecordedPanel[];
  /** Documents opened with `openTextDocument({ content })`. */
  readonly documents: { language?: string; content: string }[];
  readonly webviewViewProviders: Map<string, unknown>;
  readonly outputChannels: string[];
  readonly diagnosticCollections: string[];
  readonly disposed: number;
  readonly shown: { kind: 'error' | 'warning' | 'info'; message: string }[];
}

/** A Memento that keeps what it is given, like the real one across a session. */
class Memento {
  private readonly store = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  get<T>(key: string, fallback?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  setKeysForSync(): void {
    /* nothing to sync */
  }
}

/** SecretStorage, in memory. The real one is the OS keychain. */
class Secrets {
  // Not `store`: the interface's own method is called that.
  private readonly kept = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.kept.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.kept.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.kept.delete(key);
  }

  readonly onDidChange = () => ({ dispose: () => undefined });
}

class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];

  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

const nothing = () => ({ dispose: () => undefined });

/**
 * Builds the stub and the record of what was done to it.
 *
 * Returned together so a test can hold the record without reaching into the
 * module the extension imported.
 */
/**
 * A fresh ExtensionContext.
 *
 * Separate from the API, because activating twice against a new context is
 * what reloading the window does, and the module under test binds its
 * `import * as vscode` once at load.
 */
export function makeContext(): any {
  const uri = (path: string) => ({
    scheme: 'file',
    path,
    fsPath: path,
    toString: () => `file://${path}`,
    with: (change: { path?: string }) => uri(change.path ?? path),
  });

  return {
    subscriptions: [] as { dispose(): void }[],
    workspaceState: new Memento(),
    globalState: new Memento(),
    secrets: new Secrets(),
    extensionUri: uri('/extension'),
    extensionPath: '/extension',
    asAbsolutePath: (relative: string) => `/extension/${relative}`,
    storageUri: uri('/storage'),
    globalStorageUri: uri('/global-storage'),
    logUri: uri('/log'),
    extensionMode: 2,
  };
}

export function makeVscodeStub(): { api: any; recorded: Recorded; context: any } {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const webviewViewProviders = new Map<string, unknown>();
  const outputChannels: string[] = [];
  const diagnosticCollections: string[] = [];
  const panels: RecordedPanel[] = [];
  const documents: { language?: string; content: string }[] = [];
  const shown: Recorded['shown'] = [];
  let disposed = 0;

  const uri = (path: string) => ({
    scheme: 'file',
    path,
    fsPath: path,
    toString: () => `file://${path}`,
    with: (change: { path?: string }) => uri(change.path ?? path),
  });

  const disposable = () => ({
    dispose: () => {
      disposed += 1;
    },
  });

  const webview = (record: RecordedPanel) => ({
    html: '',
    options: {},
    cspSource: 'vscode-webview:',
    asWebviewUri: (target: { path: string }) => uri(target.path),
    postMessage: async (message: Record<string, unknown>) => {
      record.posted.push(message);
      return true;
    },
    onDidReceiveMessage: nothing,
  });

  const api = {
    Uri: {
      file: uri,
      parse: uri,
      joinPath: (base: { path: string }, ...parts: string[]) =>
        uri([base.path, ...parts].join('/')),
    },

    ViewColumn: { One: 1, Two: 2, Three: 3, Beside: -2, Active: -1 },
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },

    EventEmitter,
    Disposable: class {
      static from() {
        return disposable();
      }
      dispose() {
        disposed += 1;
      }
    },

    Position: class {
      constructor(
        readonly line: number,
        readonly character: number,
      ) {}
    },
    Range: class {
      constructor(
        readonly start: unknown,
        readonly end: unknown,
      ) {}
    },
    Selection: class {
      constructor(
        readonly anchor: unknown,
        readonly active: unknown,
      ) {}
    },
    Location: class {
      constructor(
        readonly uri: unknown,
        readonly range: unknown,
      ) {}
    },
    Diagnostic: class {
      source?: string;
      relatedInformation?: unknown[];
      constructor(
        readonly range: unknown,
        readonly message: string,
        readonly severity?: number,
      ) {}
    },
    DiagnosticRelatedInformation: class {
      constructor(
        readonly location: unknown,
        readonly message: string,
      ) {}
    },
    MarkdownString: class {
      value = '';
      isTrusted = false;
      appendMarkdown(text: string) {
        this.value += text;
        return this;
      }
      appendCodeblock(text: string) {
        this.value += text;
        return this;
      }
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },

    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [] as unknown[],
      createOutputChannel: (name: string) => {
        outputChannels.push(name);
        return {
          name,
          append: () => undefined,
          appendLine: () => undefined,
          clear: () => undefined,
          show: () => undefined,
          hide: () => undefined,
          replace: () => undefined,
          dispose: () => {
            disposed += 1;
          },
        };
      },
      createWebviewPanel: (viewType: string, title: string) => {
        const record: RecordedPanel = { viewType, title, posted: [] };
        panels.push(record);
        return {
        title,
        webview: webview(record),
        visible: true,
        active: true,
        viewColumn: 1,
        reveal: () => undefined,
        onDidDispose: nothing,
        onDidChangeViewState: nothing,
        dispose: () => {
          disposed += 1;
        },
        };
      },
      createTextEditorDecorationType: () => ({
        key: 'decoration',
        dispose: () => {
          disposed += 1;
        },
      }),
      registerWebviewViewProvider: (id: string, provider: unknown) => {
        webviewViewProviders.set(id, provider);
        return disposable();
      },
      onDidChangeTextEditorSelection: nothing,
      onDidChangeActiveTextEditor: nothing,
      showErrorMessage: async (message: string) => {
        shown.push({ kind: 'error', message });
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        shown.push({ kind: 'warning', message });
        return undefined;
      },
      showInformationMessage: async (message: string) => {
        shown.push({ kind: 'info', message });
        return undefined;
      },
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => ({ document: {}, selection: {}, revealRange: () => undefined }),
      withProgress: async (_options: unknown, task: (progress: unknown) => Promise<unknown>) =>
        task({ report: () => undefined }),
    },

    workspace: {
      workspaceFolders: undefined,
      textDocuments: [] as unknown[],
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
        has: () => false,
        inspect: () => undefined,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: nothing,
      onDidChangeConfiguration: nothing,
      openTextDocument: async (options?: { language?: string; content?: string }) => {
        const content = options?.content ?? '';
        if (options && 'content' in options) {
          documents.push({ language: options.language, content });
        }
        return {
          getText: () => content,
          uri: uri('/untitled'),
          lineCount: content.split(String.fromCharCode(10)).length,
          languageId: options?.language ?? 'plaintext',
        };
      },
      findFiles: async () => [],
      asRelativePath: (target: unknown) =>
        typeof target === 'string' ? target : ((target as { path?: string }).path ?? ''),
      fs: {
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
        stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
      },
    },

    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return disposable();
      },
      executeCommand: async () => undefined,
      getCommands: async () => [...commands.keys()],
    },

    languages: {
      createDiagnosticCollection: (name: string) => {
        diagnosticCollections.push(name);
        return {
          name,
          set: () => undefined,
          delete: () => undefined,
          clear: () => undefined,
          dispose: () => {
            disposed += 1;
          },
        };
      },
    },

    env: {
      clipboard: { writeText: async () => undefined, readText: async () => '' },
      openExternal: async () => true,
    },
  };

  const context = makeContext();

  const recorded: Recorded = {
    commands,
    webviewViewProviders,
    outputChannels,
    diagnosticCollections,
    panels,
    documents,
    shown,
    get disposed() {
      return disposed;
    },
  } as Recorded;

  return { api, recorded, context };
}

/**
 * Makes `require('vscode')` resolve to `api`, and returns the undo.
 *
 * The extension is compiled CJS, so this is done by intercepting resolution
 * rather than by rewriting any imports.
 */
let installedApi: unknown;

export function installVscode(api: unknown): () => void {
  // Installing a second, different stub in one process is always a mistake and
  // never an obvious one. The extension module binds its `import * as vscode`
  // the first time it is required and keeps that binding, so the second stub
  // is simply ignored: commands go on being registered into the first one, and
  // a test reading the second finds an empty map and reports a working command
  // as missing. That cost three debugging sessions before it was worth saying
  // out loud.
  if (installedApi !== undefined && installedApi !== api) {
    throw new Error(
      'A different vscode stub is already installed in this process. The extension ' +
        'module is bound to the first one, so the second would be ignored — share ' +
        'one stub across the file, or use makeContext() for a fresh context.',
    );
  }
  installedApi = api;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('node:module') as {
    _resolveFilename(request: string, ...rest: unknown[]): string;
  };

  const id = 'vscode-stub-for-tests';
  require.cache[id] = { id, filename: id, loaded: true, exports: api } as never;

  const original = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? id : original.call(this, request, ...rest);
  };

  return () => {
    Module._resolveFilename = original;
    delete require.cache[id];
    installedApi = undefined;
  };
}

/**
 * A TextDocument and an editor showing it, with no selection.
 *
 * Only the members the extension actually reaches for: the text, the offsets
 * both ways, one line at a time, and a uri to key the panel and the
 * diagnostics off. `openEditor` puts it where `activeTextEditor` will find it.
 */
export function makeDocument(path: string, text: string): any {
  const lines = text.split(String.fromCharCode(10));

  const offsetOf = (line: number, character: number) => {
    let offset = 0;
    for (let index = 0; index < line; index += 1) {
      offset += (lines[index] ?? '').length + 1;
    }
    return offset + character;
  };

  const positionAt = (offset: number) => {
    let remaining = offset;
    for (let line = 0; line < lines.length; line += 1) {
      const length = (lines[line] ?? '').length;
      if (remaining <= length) {
        return { line, character: remaining };
      }
      remaining -= length + 1;
    }
    return { line: Math.max(lines.length - 1, 0), character: 0 };
  };

  return {
    uri: {
      scheme: 'file',
      path,
      fsPath: path,
      toString: () => `file://${path}`,
    },
    fileName: path,
    languageId: 'sql',
    lineCount: lines.length,
    getText: (range?: unknown) => (range ? '' : text),
    lineAt: (line: number) => ({ lineNumber: line, text: lines[line] ?? '' }),
    offsetAt: (position: { line: number; character: number }) =>
      offsetOf(position.line, position.character),
    positionAt,
    save: async () => true,
  };
}

/** Puts a document in front of the user, with the cursor at the top. */
export function openEditor(api: any, document: any): void {
  const editor = {
    document,
    // Empty: "the whole file", which is what a migration wants.
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    revealRange: () => undefined,
    setDecorations: () => undefined,
  };

  api.window.activeTextEditor = editor;
  api.window.visibleTextEditors = [editor];
  api.workspace.textDocuments = [document];
}
