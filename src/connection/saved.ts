import * as vscode from 'vscode';
import { Engine } from '../adapters/types';

/**
 * Connections someone has saved, and where their passwords live.
 *
 * Two stores, deliberately. The label, the engine and the id go in global
 * state, which is ordinary JSON on disk and shows up in settings sync. The
 * connection string — the thing with the password in it — goes in
 * `SecretStorage`, which is the OS keychain.
 *
 * That split is the whole design. It means the list of connections can be read,
 * rendered and reordered without ever touching a credential, and it means a
 * credential is only ever fetched at the moment it is used. The extension has
 * never written a password to settings or to workspace state, and this keeps it
 * that way while making connections something you can actually click.
 */

export interface SavedConnection {
  readonly id: string;
  /** What to call it in a list. Defaults to `database on host`. */
  readonly label: string;
  readonly engine: Engine;
  /** ISO, for ordering by most recently used. */
  readonly lastUsed: string;
}

const LIST_KEY = 'dryrun.connections';
const SECRET_PREFIX = 'dryrun.connection.';

export class SavedConnections {
  constructor(
    private readonly state: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  /** Most recently used first, which is the order anyone wants them in. */
  all(): SavedConnection[] {
    const stored = this.state.get<unknown>(LIST_KEY, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored
      .filter(isSaved)
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
  }

  /**
   * Saves a connection and returns it.
   *
   * The string never passes through `state`; only the label does, and the label
   * is built from the host and database with the password already gone.
   */
  async save(entry: {
    label: string;
    engine: Engine;
    connectionString: string;
  }): Promise<SavedConnection> {
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const saved: SavedConnection = {
      id,
      label: entry.label,
      engine: entry.engine,
      lastUsed: new Date().toISOString(),
    };

    await this.secrets.store(SECRET_PREFIX + id, entry.connectionString);
    await this.state.update(LIST_KEY, [saved, ...this.all()]);
    return saved;
  }

  /** The credential, fetched at the moment it is used and not before. */
  async secretFor(id: string): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX + id);
  }

  async touch(id: string): Promise<void> {
    const updated = this.all().map((entry) =>
      entry.id === id ? { ...entry, lastUsed: new Date().toISOString() } : entry,
    );
    await this.state.update(LIST_KEY, updated);
  }

  async rename(id: string, label: string): Promise<void> {
    const updated = this.all().map((entry) => (entry.id === id ? { ...entry, label } : entry));
    await this.state.update(LIST_KEY, updated);
  }

  /** Removes the entry and its secret. The secret first, so nothing is orphaned. */
  async forget(id: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + id);
    await this.state.update(
      LIST_KEY,
      this.all().filter((entry) => entry.id !== id),
    );
  }
}

function isSaved(value: unknown): value is SavedConnection {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['label'] === 'string' &&
    typeof entry['engine'] === 'string' &&
    typeof entry['lastUsed'] === 'string'
  );
}
