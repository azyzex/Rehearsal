/**
 * Production detection.
 *
 * Dry Run executes real statements against whatever database it is pointed at.
 * Rolled back or not, that is not something to do casually against production:
 * it takes real locks, burns real I/O, and shares a connection slot with real
 * traffic. So a connection whose identity looks like production is refused
 * outright.
 *
 * There is deliberately no "connect anyway" affordance here. The escape hatch
 * is editing `dryrun.allowedConnections` in settings, which is slow enough to
 * require actually meaning it.
 */

export interface GuardOptions {
  /** Case-insensitive regular expression sources. */
  readonly productionPatterns: readonly string[];
  /** Exempt connections, as `host:port/database`. */
  readonly allowedConnections: readonly string[];
}

export interface ConnectionIdentity {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  /** `host:port/database` — the form used in `dryrun.allowedConnections`. */
  readonly key: string;
  /** Safe to display and to log. Never contains the password. */
  readonly display: string;
}

export type GuardResult =
  | { readonly allowed: true; readonly identity: ConnectionIdentity }
  | {
      readonly allowed: false;
      readonly identity: ConnectionIdentity;
      readonly matchedPattern: string;
      readonly reason: string;
    };

/**
 * Extracts the parts of a connection string that are safe to show, log, and
 * pattern-match. The password is dropped here and never travels further.
 */
export function identify(connectionString: string): ConnectionIdentity {
  let host = 'localhost';
  let port = '5432';
  let database = '';
  let user = '';

  try {
    const url = new URL(connectionString);
    host = decodeURIComponent(url.hostname) || host;
    port = url.port || port;
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    user = decodeURIComponent(url.username);
  } catch {
    // Key/value form: "host=db.example.com port=5432 dbname=app user=me"
    const read = (key: string): string => {
      const m = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'i').exec(connectionString);
      return m?.[1] ?? '';
    };
    host = read('host') || host;
    port = read('port') || port;
    database = read('dbname') || read('database');
    user = read('user');
  }

  const key = `${host}:${port}/${database}`;
  const display = user ? `${user}@${key}` : key;

  return { host, port, database, user, key, display };
}

/** Returns whether Dry Run is willing to connect to this database. */
export function checkConnection(connectionString: string, options: GuardOptions): GuardResult {
  const identity = identify(connectionString);

  if (options.allowedConnections.some((allowed) => allowed.trim() === identity.key)) {
    return { allowed: true, identity };
  }

  // Matched against the redacted identity only. A password containing the
  // word "prod" is neither a signal nor any of our business.
  const haystack = identity.display;

  for (const source of options.productionPatterns) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'i');
    } catch {
      continue; // a malformed user pattern must not break connecting
    }

    if (pattern.test(haystack)) {
      return {
        allowed: false,
        identity,
        matchedPattern: source,
        reason:
          `This connection (${identity.display}) matches the production pattern ` +
          `"${source}". Dry Run will not run previews against it. Point it at a ` +
          `staging database or a replica instead — or, if this really is safe, ` +
          `add "${identity.key}" to dryrun.allowedConnections in settings.`,
      };
    }
  }

  return { allowed: true, identity };
}
