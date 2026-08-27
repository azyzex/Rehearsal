import { MongoAdapter } from './mongo';
import { MysqlAdapter } from './mysql';
import { PostgresAdapter } from './postgres';
import { SqliteAdapter } from './sqlite';
import { DatabaseAdapter } from './types';

/**
 * Which adapter a connection string asks for.
 *
 * Read off the scheme rather than probed, because probing means connecting, and
 * connecting to a production database to find out what it is would be a strange
 * first move for a tool built around not touching things. Anything unrecognised
 * is treated as Postgres, which is the scheme people most often leave off.
 *
 * Deliberately in its own file with no `vscode` import: the CLI needs it too,
 * and it is bundled separately precisely so that an accidental editor
 * dependency fails the build rather than failing in someone's CI.
 */
export function adapterFor(connectionString: string): DatabaseAdapter {
  const scheme = /^([a-z0-9+]+):/i.exec(connectionString.trim())?.[1]?.toLowerCase() ?? '';

  if (scheme === 'mysql' || scheme === 'mariadb') {
    return new MysqlAdapter();
  }
  if (scheme === 'mongodb' || scheme === 'mongodb+srv') {
    return new MongoAdapter();
  }
  // A file rather than a server, so it is recognised by extension as well as by
  // scheme: people write `sqlite:./app.db`, `file:app.db` and `./app.db`, and
  // treating the last one as a Postgres connection string would produce a
  // confusing failure about a host that does not exist.
  if (scheme === 'sqlite' || scheme === 'sqlite3' || scheme === 'file') {
    return new SqliteAdapter();
  }
  if (scheme === '' && /\.(db|sqlite|sqlite3)$/i.test(connectionString.trim())) {
    return new SqliteAdapter();
  }
  return new PostgresAdapter();
}
