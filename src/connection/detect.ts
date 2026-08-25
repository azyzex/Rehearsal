import { Engine } from '../adapters/types';

/**
 * Working out what someone just pasted.
 *
 * Connection strings arrive from a hosting dashboard, a `.env` file, a
 * colleague, or memory, and they arrive in whatever shape that source produces.
 * Asking the user to also tell us which database it is would be asking them to
 * repeat something the string already says.
 *
 * Everything here is pure and offline. Nothing connects, because deciding what
 * a database is by connecting to it is a strange first move for a tool built
 * around not touching things until asked.
 */

export interface Detection {
  readonly engine: Engine;
  /** The string as it should be handed to the driver. */
  readonly connectionString: string;
  /** Host and database, with the password removed. Safe to display and store. */
  readonly label: string;
  /** True when the scheme was missing and had to be inferred. */
  readonly inferred: boolean;
  /** Set when the string cannot be used at all. */
  readonly problem?: string;
  /** Things worth saying before they connect. */
  readonly notes: readonly string[];
}

const SCHEMES: Record<string, Engine> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongo',
  'mongodb+srv': 'mongo',
};

/** Default ports, for the case where the scheme is missing but the port is not. */
const PORTS: Record<string, Engine> = {
  '5432': 'postgres',
  '3306': 'mysql',
  '27017': 'mongo',
};

export function detect(raw: string): Detection {
  const input = raw.trim();

  if (input.length === 0) {
    return {
      engine: 'postgres',
      connectionString: '',
      label: '',
      inferred: false,
      problem: 'Paste a connection string.',
      notes: [],
    };
  }

  const scheme = /^([a-z0-9+]+):\/\//i.exec(input)?.[1]?.toLowerCase();

  if (scheme && SCHEMES[scheme]) {
    const engine = SCHEMES[scheme]!;
    return {
      engine,
      connectionString: input,
      ...describe(input, engine),
      inferred: false,
      notes: notesFor(engine, input),
    };
  }

  if (scheme) {
    return {
      engine: 'postgres',
      connectionString: input,
      label: '',
      inferred: false,
      problem:
        `Dry Run does not know the "${scheme}" scheme. It speaks postgresql://, ` +
        `mysql:// and mongodb://.`,
      notes: [],
    };
  }

  // No scheme. People paste `host:5432/db` and `user:pass@host/db` constantly,
  // and refusing them would be pedantry — the port says which database it is.
  const port = /:(\d{2,5})\b/.exec(input)?.[1];
  const guess: Engine = (port ? PORTS[port] : undefined) ?? 'postgres';
  const prefix = guess === 'postgres' ? 'postgresql' : guess === 'mysql' ? 'mysql' : 'mongodb';
  const connectionString = `${prefix}://${input}`;

  return {
    engine: guess,
    connectionString,
    ...describe(connectionString, guess),
    inferred: true,
    notes: notesFor(guess, connectionString),
  };
}

/**
 * Host and database, with the credential removed.
 *
 * This is what gets shown in the panel and stored beside the secret, so it must
 * never carry a password. Parsed rather than pattern-matched, because a
 * password containing an `@` breaks every regex anyone writes for this.
 */
function describe(connectionString: string, engine: Engine): { label: string; problem?: string } {
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('?')[0] ?? '');
    const host = url.hostname || 'localhost';

    if (host.length === 0) {
      return { label: '', problem: 'That has no host in it.' };
    }

    return { label: database ? `${database} on ${host}` : `${engine} on ${host}` };
  } catch {
    return { label: '', problem: 'That is not a connection string Dry Run can read.' };
  }
}

/**
 * What to say before they connect.
 *
 * Each of these is a condition that produces a confusing failure later if it is
 * not mentioned now.
 */
function notesFor(engine: Engine, connectionString: string): string[] {
  const notes: string[] = [];

  if (engine === 'mongo' && !/[?&]replicaSet=/i.test(connectionString)) {
    const srv = connectionString.startsWith('mongodb+srv://');
    if (!srv) {
      notes.push(
        'Previews need a replica set. MongoDB rolls back with a transaction and a ' +
          'standalone server has none, so Dry Run will refuse rather than run a preview ' +
          'it could not undo. Atlas connections are replica sets.',
      );
    }
  }

  if (engine === 'postgres' && /-pooler\./.test(connectionString)) {
    notes.push(
      'This is a pooled endpoint. Pooled connections drop session state between ' +
        'statements, which a preview depends on — use the direct endpoint instead.',
    );
  }

  if (/^\w+:\/\/[^@/]*@/.test(connectionString) === false && engine !== 'mongo') {
    notes.push('No username in the string — the driver will fall back to your OS user.');
  }

  return notes;
}

/** A one-word name for the engine, for a badge. */
export function engineName(engine: Engine): string {
  return engine === 'postgres' ? 'PostgreSQL' : engine === 'mysql' ? 'MySQL' : 'MongoDB';
}
