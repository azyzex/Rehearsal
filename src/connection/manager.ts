import * as vscode from 'vscode';
import { PostgresAdapter } from '../adapters/postgres';
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
export class ConnectionManager implements vscode.Disposable {
  private adapter: PostgresAdapter | null = null;
  private active: ActiveConnection | null = null;

  get current(): ActiveConnection | null {
    return this.active;
  }

  /** Returns the open connection, opening one if needed. */
  async acquire(): Promise<ActiveConnection> {
    if (this.active) {
      return this.active;
    }

    const config = vscode.workspace.getConfiguration('dryrun');
    const resolved = resolveConnection({
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

    const adapter = new PostgresAdapter();
    await adapter.connect(connectionConfig);

    this.adapter = adapter;
    this.active = {
      adapter,
      identity: identify(resolved.connectionString),
      source: resolved.source.detail,
    };
    return this.active;
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    this.active = null;
    if (adapter) {
      await adapter.dispose();
    }
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

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const found = await this.tryReadEnv(vscode.Uri.joinPath(folder.uri, relativePath));
      if (found) {
        return found;
      }
    }

    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      // Walk up from the file's own directory to the filesystem root.
      let directory = vscode.Uri.joinPath(active, '..');
      for (let depth = 0; depth < 24; depth++) {
        const found = await this.tryReadEnv(vscode.Uri.joinPath(directory, relativePath));
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

  private async tryReadEnv(
    uri: vscode.Uri,
  ): Promise<{ envFileContents: string; envFilePath: string } | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        envFileContents: new TextDecoder().decode(bytes),
        envFilePath: vscode.workspace.asRelativePath(uri),
      };
    } catch {
      return undefined;
    }
  }
}

export { APPLICATION_NAME, ConnectionResolutionError };
