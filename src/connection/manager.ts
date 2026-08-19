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

  /** Reads the workspace `.env` file, if there is one. Absence is not an error. */
  private async readEnvFile(
    relativePath: string,
  ): Promise<{ envFileContents?: string; envFilePath?: string }> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || relativePath.trim().length === 0) {
      return {};
    }

    const uri = vscode.Uri.joinPath(folder.uri, relativePath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { envFileContents: new TextDecoder().decode(bytes), envFilePath: relativePath };
    } catch {
      return {};
    }
  }
}

export { APPLICATION_NAME, ConnectionResolutionError };
