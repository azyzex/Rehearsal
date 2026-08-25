import * as vscode from 'vscode';
import { describeError } from '../errors';
import { Engine } from '../adapters/types';
import { ConnectionManager } from '../connection/manager';
import { SavedConnections } from '../connection/saved';
import { detect, engineName } from '../connection/detect';
import { sidebarHtml } from './html';
import { htmlOptionsFor } from './htmlOptions';

/**
 * The view in the activity bar.
 *
 * Everything this extension does was reachable only through the command palette
 * and a `.env` file the user had to already have. That is a fine way to build a
 * thing and a poor way to hand it to someone: it means the first run is a
 * search through a list of commands for one whose name you have to already
 * know, and a failure whose cause is a file you have not written yet.
 *
 * So the extension gets a front door. Click the icon, paste a connection
 * string, and the engine is worked out from it — the string already says which
 * database it is, and asking again would be asking twice. Once connected, this
 * becomes the launcher for everything else.
 *
 * A `WebviewView` rather than a tree, because the connect step is a form and a
 * tree is a poor form.
 */

export interface SidebarHost {
  readonly connections: ConnectionManager;
  readonly saved: SavedConnections;
  /** Runs one of the extension's commands, by id. */
  run(command: string): void;
  report(error: unknown): void;
}

export class Sidebar implements vscode.WebviewViewProvider {
  static readonly viewId = 'dryrun.sidebar';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: SidebarHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = sidebarHtml(htmlOptionsFor(view.webview, this.context.extensionUri));

    view.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      void this.onMessage(message);
    });

    // Re-sent when the view comes back after being hidden: a webview that has
    // been collapsed and reopened is a fresh page with no state at all.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh();
      }
    });

    void this.refresh();
  }

  /** Brings the view into focus, for the "you are not connected" path. */
  static reveal(): void {
    void vscode.commands.executeCommand(`${Sidebar.viewId}.focus`);
  }

  /** Pushes the current state: connected or not, and what is saved. */
  async refresh(): Promise<void> {
    const active = this.host.connections.current;

    this.post({
      type: 'state',
      connected: active
        ? {
            label: active.identity.display,
            engine: active.adapter.engine,
            engineName: engineName(active.adapter.engine),
            source: active.source,
            transactionalDdl: active.adapter.supportsTransactionalDDL,
          }
        : null,
      saved: this.host.saved.all(),
    });
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    const type = String(message['type'] ?? '');

    switch (type) {
      case 'ready':
        await this.refresh();
        return;

      case 'detect':
        // Runs on every keystroke, so it must not touch the network. It does
        // not: detection is a string parse.
        this.post({ type: 'detected', detection: detect(String(message['value'] ?? '')) });
        return;

      case 'connect':
        await this.connect(String(message['value'] ?? ''), Boolean(message['remember']));
        return;

      case 'connectSaved':
        await this.connectSaved(String(message['id'] ?? ''));
        return;

      case 'forget':
        await this.host.saved.forget(String(message['id'] ?? ''));
        await this.refresh();
        return;

      case 'rename': {
        const label = String(message['label'] ?? '').trim();
        if (label.length > 0) {
          await this.host.saved.rename(String(message['id'] ?? ''), label);
        }
        await this.refresh();
        return;
      }

      case 'disconnect':
        await this.host.connections.clearChoice();
        await this.refresh();
        return;

      case 'run':
        this.host.run(String(message['command'] ?? ''));
        return;

      case 'pickEnvFile':
        await this.pickEnvFile();
        return;

      default:
        return;
    }
  }

  private async connect(raw: string, remember: boolean): Promise<void> {
    const detection = detect(raw);
    if (detection.problem) {
      this.post({ type: 'failed', message: detection.problem });
      return;
    }

    this.post({ type: 'connecting' });

    try {
      const active = await this.host.connections.useConnectionString(detection.connectionString);

      if (remember) {
        // Saved only after it has worked. Storing a connection string that
        // does not connect is storing a problem for later.
        await this.host.saved.save({
          label: detection.label || active.identity.display,
          engine: active.adapter.engine,
          connectionString: detection.connectionString,
        });
      }

      await this.refresh();
      this.post({ type: 'connected' });
    } catch (error) {
      this.host.report(error);
      this.post({ type: 'failed', message: errorMessage(error) });
    }
  }

  private async connectSaved(id: string): Promise<void> {
    const secret = await this.host.saved.secretFor(id);
    if (!secret) {
      this.post({
        type: 'failed',
        message:
          'That connection is in the list but its password is not in the keychain. ' +
          'Remove it and add it again.',
      });
      return;
    }

    this.post({ type: 'connecting' });

    try {
      await this.host.connections.useConnectionString(secret);
      await this.host.saved.touch(id);
      await this.refresh();
      this.post({ type: 'connected' });
    } catch (error) {
      this.host.report(error);
      this.post({ type: 'failed', message: errorMessage(error) });
    }
  }

  private async pickEnvFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use this file',
      title: 'Select the .env file holding your connection string',
      filters: { 'Environment files': ['env'], 'All files': ['*'] },
    });

    if (!picked?.[0]) {
      return;
    }

    await this.host.connections.useEnvFile(picked[0]);
    this.post({ type: 'connecting' });

    try {
      await this.host.connections.acquire();
      await this.refresh();
      this.post({ type: 'connected' });
    } catch (error) {
      this.host.report(error);
      this.post({ type: 'failed', message: errorMessage(error) });
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}

/**
 * Kept as a name because it is used everywhere; the work moved to errors.ts
 * after an AggregateError with an empty message rendered as an empty red box.
 */
function errorMessage(error: unknown): string {
  return describeError(error);
}

export type { Engine };
