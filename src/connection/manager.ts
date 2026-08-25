import * as vscode from 'vscode';
import { adapterFor } from '../adapters/select';
import { ConnectionConfig, DatabaseAdapter } from '../adapters/types';
import { checkConnection, ConnectionIdentity, identify } from './guard';
import { ConnectionResolutionError, resolveConnection } from './resolve';
import { APPLICATION_NAME } from '../constants';

export class ProductionRefusedError extends Error {
  constructor(
    message: string,
    public readonly identity: ConnectionIdentity,
    public readonly matchedPattern: string,
  ) {
    super(message);
    this.name = 'ProductionRefusedError';
  }
}

export interface ActiveConnection {
  readonly adapter: DatabaseAdapter;
  readonly identity: ConnectionIdentity;
  /** Human-readable origin of the connection string, e.g. "DATABASE_URL in .env". */
  readonly source: string;
}

/**
 * Owns the single database connection (spec §10.8) and every check that has to
 * pass before it is opened.
 *
 * Registered in `context.subscriptions`, so deactivating the extension always
 * closes the socket and drops the credentials held in memory.
 */
/**
 * Where the last usable `.env` was found. Only the path is remembered, never
 * anything read out of it — a location is not a credential.
 */
const ENV_PATH_KEY = 'dryrun.lastEnvFile';

export class ConnectionManager implements vscode.Disposable {
  private adapter: DatabaseAdapter | null = null;
  private active: ActiveConnection | null = null;
  /** A connection the user picked, which outranks anything found on disk. */
  private chosen: string | undefined;
  /**
   * Told whenever the connection opens or closes.
   *
   * The sidebar shows what is connected, and connecting happens in three
   * places — the sidebar itself, a command, and the .env fallback. Without
   * this it would only ever be right about the first.
   */
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly state?: vscode.Memento) {}

  get current(): ActiveConnection | null {
    return this.active;
  }

  onChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener that throws is not a reason to fail a connection.
      }
    }
  }

  /** Points the manager at a specific `.env`, chosen by the user. */
  async useEnvFile(uri: vscode.Uri): Promise<void> {
    await this.state?.update(ENV_PATH_KEY, uri.toString());
    await this.close();
  }

  /**
   * Connects to a string the user chose, rather than one found for them.
   *
   * This is the path the sidebar uses. It wins over the `.env` search for as
   * long as it is set, because someone who has just picked a database means
   * that database — falling back to whatever a file in the workspace says
   * would be the tool overruling them silently.
   *
   * The string is held in memory only. It came from the keychain and it goes
   * nowhere else.
   */
  async useConnectionString(connectionString: string): Promise<ActiveConnection> {
    await this.close();
    this.chosen = connectionString;
    return this.acquire();
  }

  /** Goes back to finding a connection the usual way. */
  async clearChoice(): Promise<void> {
    this.chosen = undefined;
    await this.close();
  }

  /** Returns the open connection, opening one if needed. */
  async acquire(): Promise<ActiveConnection> {
    if (this.active) {
      return this.active;
    }

    const config = vscode.workspace.getConfiguration('dryrun');
    const resolved = this.chosen
      ? { connectionString: this.chosen, source: { kind: 'chosen' as const, detail: 'chosen in the sidebar' } }
      : resolveConnection({
          setting: config.get<string>('connectionString', ''),
          env: process.env,
          ...(await this.readEnvFile(config.get<string>('envFile', '.env'))),
        });

    const verdict = checkConnection(resolved.connectionString, {
      productionPatterns: config.get<string[]>('productionPatterns', ['prod', 'production', 'live']),
      allowedConnections: config.get<string[]>('allowedConnections', []),
    });

    if (!verdict.allowed) {
      throw new ProductionRefusedError(verdict.reason, verdict.identity, verdict.matchedPattern);
    }

    const connectionConfig: ConnectionConfig = {
      connectionString: resolved.connectionString,
      statementTimeoutMs: config.get<number>('statementTimeoutMs', 5000),
      lockTimeoutMs: Math.max(config.get<number>('lockTimeoutMs', 2000), 100),
      applicationName: APPLICATION_NAME,
    };

    const adapter = adapterFor(resolved.connectionString);
    await adapter.connect(connectionConfig);

    this.adapter = adapter;
    this.active = {
      adapter,
      identity: identify(resolved.connectionString),
      source: resolved.source.detail,
    };
    this.changed();
    return this.active;
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    this.active = null;
    if (adapter) {
      await adapter.dispose();
    }
    this.changed();
  }

  dispose(): void {
    void this.close();
  }

  /**
   * Finds the `.env` file. Absence is not an error.
   *
   * Looked for in the workspace folders first, and then by walking up from the
   * file being previewed. That second path matters more than it looks: opening
   * a single `.sql` file without opening its folder is a completely ordinary
   * thing to do, and it leaves `workspaceFolders` empty, so a workspace-only
   * lookup finds nothing and the extension claims there is no connection
   * configured when there is one sitting next to the file.
   */
  private async readEnvFile(
    relativePath: string,
  ): Promise<{ envFileContents?: string; envFilePath?: string }> {
    if (relativePath.trim().length === 0) {
      return {};
    }

    // 1. Wherever it was found last time. Commands like the schema explorer run
    //    with a webview focused and no editor active, so without this the
    //    lookup would depend on what happens to have focus.
    const remembered = this.state?.get<string>(ENV_PATH_KEY);
    if (remembered) {
      const found = await this.tryReadEnv(vscode.Uri.parse(remembered));
      if (found) {
        return found;
      }
    }

    // 2. The workspace, when one is open.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const found = await this.remember(
        await this.tryReadEnv(vscode.Uri.joinPath(folder.uri, relativePath)),
      );
      if (found) {
        return found;
      }
    }

    // 3. Walking up from every open file. Opening a lone .sql file without its
    //    folder is ordinary, and so is having several open at once.
    const seen = new Set<string>();
    for (const document of openDocuments()) {
      let directory = vscode.Uri.joinPath(document, '..');

      for (let depth = 0; depth < 24; depth++) {
        if (seen.has(directory.path)) {
          break; // another file already walked this branch
        }
        seen.add(directory.path);

        const found = await this.remember(
          await this.tryReadEnv(vscode.Uri.joinPath(directory, relativePath)),
        );
        if (found) {
          return found;
        }

        const parent = vscode.Uri.joinPath(directory, '..');
        if (parent.path === directory.path) {
          break;
        }
        directory = parent;
      }
    }

    return {};
  }

  private async remember<T extends { envFileUri?: vscode.Uri } | undefined>(found: T): Promise<T> {
    if (found?.envFileUri) {
      await this.state?.update(ENV_PATH_KEY, found.envFileUri.toString());
    }
    return found;
  }

  private async tryReadEnv(
    uri: vscode.Uri,
  ): Promise<
    { envFileContents: string; envFilePath: string; envFileUri: vscode.Uri } | undefined
  > {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        envFileContents: new TextDecoder().decode(bytes),
        envFilePath: vscode.workspace.asRelativePath(uri),
        envFileUri: uri,
      };
    } catch {
      return undefined;
    }
  }
}

/** Every open file, active editor first so the obvious answer is tried first. */
function openDocuments(): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const add = (uri: vscode.Uri | undefined): void => {
    if (uri?.scheme === 'file' && !uris.some((seen) => seen.path === uri.path)) {
      uris.push(uri);
    }
  };

  add(vscode.window.activeTextEditor?.document.uri);
  for (const editor of vscode.window.visibleTextEditors) {
    add(editor.document.uri);
  }
  for (const document of vscode.workspace.textDocuments) {
    add(document.uri);
  }
  return uris;
}

export { APPLICATION_NAME, ConnectionResolutionError };
