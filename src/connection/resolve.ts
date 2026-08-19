/**
 * Where the connection string comes from.
 *
 * Credentials are never written by this extension — not to settings, not to
 * workspace state, not to disk. They are read from the environment or from a
 * `.env` file the user already has, held in memory, and dropped when the
 * adapter is disposed.
 *
 * This module is deliberately free of `vscode` imports so it can be tested
 * directly.
 */

export type ConnectionSource =
  | { readonly kind: 'setting'; readonly detail: string }
  | { readonly kind: 'env'; readonly detail: string }
  | { readonly kind: 'envFile'; readonly detail: string };

export interface ResolvedConnection {
  readonly connectionString: string;
  readonly source: ConnectionSource;
}

/** Variables checked, in order, in both the process environment and the .env file. */
export const CONNECTION_ENV_KEYS = ['DRYRUN_DATABASE_URL', 'DATABASE_URL'] as const;

export interface ResolveInputs {
  /** Value of `dryrun.connectionString`, which may contain `${env:VAR}`. */
  readonly setting: string;
  /** Process environment. */
  readonly env: Record<string, string | undefined>;
  /** Raw contents of the workspace `.env` file, if one was found. */
  readonly envFileContents?: string;
  /** Path of that file, for reporting. */
  readonly envFilePath?: string;
}

/**
 * Minimal `.env` reader: `KEY=value`, `export KEY=value`, `#` comments, and
 * optional single or double quotes around the value. Deliberately not a full
 * dotenv implementation — this only has to find a connection string.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    let value = match[2]!.trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment only on unquoted values.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    out[key] = value;
  }

  return out;
}

/** Expands `${env:VAR}` references against the given environment. */
export function expandEnvReferences(
  value: string,
  env: Record<string, string | undefined>,
): { readonly expanded: string; readonly missing: string[] } {
  const missing: string[] = [];

  const expanded = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
    const found = env[name];
    if (found === undefined || found.length === 0) {
      missing.push(name);
      return '';
    }
    return found;
  });

  return { expanded, missing };
}

export class ConnectionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionResolutionError';
  }
}

/**
 * Resolves a connection string from, in order of precedence:
 *   1. `dryrun.connectionString` (with `${env:VAR}` expanded)
 *   2. `DRYRUN_DATABASE_URL` / `DATABASE_URL` in the process environment
 *   3. the same keys in the workspace `.env` file
 */
export function resolveConnection(inputs: ResolveInputs): ResolvedConnection {
  const setting = inputs.setting.trim();

  if (setting.length > 0) {
    const { expanded, missing } = expandEnvReferences(setting, inputs.env);
    if (missing.length > 0) {
      throw new ConnectionResolutionError(
        `dryrun.connectionString references ${missing.map((m) => `$${m}`).join(', ')}, ` +
          `which ${missing.length === 1 ? 'is' : 'are'} not set in the environment.`,
      );
    }
    if (expanded.trim().length === 0) {
      throw new ConnectionResolutionError('dryrun.connectionString expanded to an empty value.');
    }
    return { connectionString: expanded.trim(), source: { kind: 'setting', detail: 'dryrun.connectionString' } };
  }

  for (const key of CONNECTION_ENV_KEYS) {
    const value = inputs.env[key];
    if (value && value.trim().length > 0) {
      return { connectionString: value.trim(), source: { kind: 'env', detail: key } };
    }
  }

  if (inputs.envFileContents !== undefined) {
    const parsed = parseEnvFile(inputs.envFileContents);
    for (const key of CONNECTION_ENV_KEYS) {
      const value = parsed[key];
      if (value && value.trim().length > 0) {
        return {
          connectionString: value.trim(),
          source: { kind: 'envFile', detail: `${key} in ${inputs.envFilePath ?? '.env'}` },
        };
      }
    }
  }

  throw new ConnectionResolutionError(
    `No Postgres connection found. Set ${CONNECTION_ENV_KEYS.join(' or ')} in your .env file, ` +
      `or point dryrun.connectionString at an environment variable such as \${env:DATABASE_URL}.`,
  );
}
