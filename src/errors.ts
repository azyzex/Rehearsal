/**
 * Turning a thrown thing into a sentence.
 *
 * This exists because of an empty red box. Connecting to a local database that
 * was not running produced a failure with nothing in it — Node tries `::1` and
 * `127.0.0.1`, both are refused, and it reports that as an `AggregateError`
 * whose own `message` is the empty string with the real causes hidden in
 * `.errors`. Three copies of `error.message` around this codebase all rendered
 * that as nothing at all.
 *
 * So: never return an empty string, always look inside the wrappers, and where
 * the underlying failure is one of the handful people actually hit, say what it
 * means rather than what it is called. "connect ECONNREFUSED 127.0.0.1:54329"
 * is accurate and tells you nothing you can act on.
 *
 * No `vscode` import: the CLI needs this too.
 */

interface ErrorLike {
  readonly message?: unknown;
  readonly name?: unknown;
  readonly code?: unknown;
  readonly errors?: unknown;
  readonly cause?: unknown;
  readonly address?: unknown;
  readonly port?: unknown;
  readonly hostname?: unknown;
  readonly syscall?: unknown;
}

export function describeError(error: unknown): string {
  const explained = explain(error);
  if (explained) {
    return explained;
  }

  const raw = rawMessage(error);
  return raw.length > 0 ? raw : 'Something failed without saying what.';
}

/**
 * The message, looking inside whatever is wrapping it.
 *
 * An `AggregateError` carries nothing itself; a `cause` chain carries the
 * useful part one level down. Both are unwrapped rather than reported as the
 * blank they present as.
 */
function rawMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error.trim();
  }
  if (!error || typeof error !== 'object') {
    return String(error ?? '').trim();
  }

  const like = error as ErrorLike;
  const own = typeof like.message === 'string' ? like.message.trim() : '';
  if (own.length > 0) {
    return own;
  }

  // AggregateError: the causes are the message. Deduplicated, because the
  // same refusal on IPv6 and IPv4 is one fact reported twice.
  if (Array.isArray(like.errors) && like.errors.length > 0) {
    const causes = [...new Set(like.errors.map((inner) => rawMessage(inner)))].filter(
      (text) => text.length > 0,
    );
    if (causes.length > 0) {
      return causes.join('; ');
    }
  }

  if (like.cause !== undefined && like.cause !== null) {
    const cause = rawMessage(like.cause);
    if (cause.length > 0) {
      return cause;
    }
  }

  return typeof like.name === 'string' ? like.name.trim() : '';
}

/** The first error code found anywhere in the wrappers. */
function codeOf(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const like = error as ErrorLike;

  if (typeof like.code === 'string' && like.code.length > 0) {
    return like.code;
  }
  if (Array.isArray(like.errors)) {
    for (const inner of like.errors) {
      const found = codeOf(inner);
      if (found) {
        return found;
      }
    }
  }
  return like.cause ? codeOf(like.cause) : '';
}

/** Where it was trying to reach, when the error says. */
function target(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const like = error as ErrorLike;

  const host =
    (typeof like.hostname === 'string' && like.hostname) ||
    (typeof like.address === 'string' && like.address) ||
    '';
  const port = typeof like.port === 'number' ? String(like.port) : '';

  if (host && port) {
    return `${host}:${port}`;
  }
  if (host) {
    return host;
  }

  if (Array.isArray(like.errors)) {
    for (const inner of like.errors) {
      const found = target(inner);
      if (found) {
        return found;
      }
    }
  }
  return like.cause ? target(like.cause) : '';
}

/**
 * The handful of failures people actually hit, said in words.
 *
 * Returns an empty string for anything not on the list, because a wrong
 * explanation is worse than the driver's own wording.
 */
function explain(error: unknown): string {
  const code = codeOf(error);
  const where = target(error);
  const at = where ? ` at ${where}` : '';

  switch (code) {
    case 'ECONNREFUSED':
      return (
        `Nothing is listening${at}. The database is not running, or it is on a ` +
        `different port.`
      );

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `That host does not resolve${at ? ` (${where})` : ''}. Check the hostname.`;

    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return (
        `No answer${at} before the timeout. The host may be firewalled, or the ` +
        `connection may need an IP allow-list entry.`
      );

    case 'ECONNRESET':
      return `The connection was closed${at} before anything came back.`;

    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return (
        'The server presented a certificate that could not be verified. Add ' +
        '`?sslmode=require` if the host uses a self-signed certificate.'
      );

    // Postgres SQLSTATEs worth naming.
    case '28P01':
      return 'The password was rejected.';
    case '28000':
      return 'The server refused this user — check the username and any IP allow-list.';
    case '3D000':
      return 'That database does not exist on this server.';

    // MySQL.
    case 'ER_ACCESS_DENIED_ERROR':
      return 'The username or password was rejected.';
    case 'ER_BAD_DB_ERROR':
      return 'That database does not exist on this server.';

    default:
      break;
  }

  // MongoDB reports an unreachable deployment as one error type whatever the
  // cause, and its own message is a paragraph of topology.
  const raw = rawMessage(error);
  if (/MongoServerSelectionError|Server selection timed out/i.test(raw)) {
    return (
      'Could not reach that MongoDB deployment. Check the host and, on Atlas, that ' +
      'your IP is on the access list.'
    );
  }

  return '';
}
