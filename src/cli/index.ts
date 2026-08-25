import * as fs from 'node:fs';
import { adapterFor } from '../adapters/select';
import { analyzeStatements } from '../analysis/orchestrator';
import { Finding, Thresholds } from '../analysis/types';
import { splitStatements } from '../parser/splitter';
import { APPLICATION_NAME } from '../constants';
import { FailLevel, markdownReport, shouldFail, textReport } from './report';

/**
 * Dry Run outside the editor.
 *
 * The same analysis, in the place a destructive migration is cheapest to
 * catch: the pull request that adds it, before anyone has deployed anything.
 * A review that says "this looks fine" is a guess; a check that says "this
 * DELETE matches 40,072 of 50,000 rows on the real database" is not.
 *
 * It reads and rolls back, like everything else here. There is no flag that
 * makes it apply anything, and that is deliberate — a CI job with credentials
 * that can write is a different and much worse thing to leave lying around.
 */

interface Options {
  readonly files: readonly string[];
  readonly connectionString: string;
  readonly failOn: FailLevel;
  readonly format: 'text' | 'markdown';
  readonly thresholds: Thresholds;
}

const USAGE = `
dryrun — measure a migration against a real database, without applying it.

  dryrun <file.sql> [more.sql ...] [options]

Options:
  --url <string>        Connection string. Defaults to $DATABASE_URL.
  --fail-on <level>     Exit non-zero at this severity or worse.
                        destructive (default), blocking, caution, never.
  --format <format>     text (default) or markdown.
  --caution-rows <n>    Rows above which a change is a caution. Default 100.
  --destructive-rows <n>  Rows above which a change is destructive. Default 1000.
  --timeout <ms>        Statement timeout inside the preview. Default 30000.
  --help                This.

Nothing is ever committed. Every statement runs inside a transaction that is
rolled back, including when it fails.
`.trim();

/**
 * Where the report goes.
 *
 * Passed in rather than written to `process.stdout` directly, so a test can
 * read what was printed without hijacking the stream the test runner is using
 * to report its own results.
 */
export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const CONSOLE: Output = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export async function run(argv: readonly string[], io: Output = CONSOLE): Promise<number> {
  let options: Options;
  try {
    const parsed = parse(argv);
    if (!parsed) {
      io.out(`${USAGE}\n`);
      return 0;
    }
    options = parsed;
  } catch (error) {
    io.err(`${message(error)}\n\n${USAGE}\n`);
    return 2;
  }

  // Whichever database the connection string names. The CLI is bundled
  // separately from the extension, so this has to reach the selector without
  // dragging `vscode` in behind it.
  const adapter = adapterFor(options.connectionString);
  let failed = false;

  try {
    await adapter.connect({
      connectionString: options.connectionString,
      statementTimeoutMs: options.thresholds.explainAnalyze ? 60_000 : 30_000,
      lockTimeoutMs: 5000,
      applicationName: APPLICATION_NAME,
    });

    // Named rather than queried: `SELECT current_database()` is SQL, and one
    // of the three engines does not speak it.
    const version = describeTarget(options.connectionString, adapter.engine);

    for (const file of options.files) {
      const sql = fs.readFileSync(file, 'utf8');
      const statements = splitStatements(sql);

      const findings: Finding[] = [];
      await analyzeStatements({
        adapter,
        statements,
        thresholds: options.thresholds,
        onFinding: (finding) => findings.push(finding),
      });

      const input = { file, connection: version, findings };
      io.out(options.format === 'markdown' ? markdownReport(input) : textReport(input));

      if (shouldFail(findings, options.failOn)) {
        failed = true;
      }
    }
  } catch (error) {
    io.err(`dryrun: ${message(error)}\n`);
    return 2;
  } finally {
    await adapter.dispose().catch(() => undefined);
  }

  return failed ? 1 : 0;
}

function parse(argv: readonly string[]): Options | undefined {
  const files: string[] = [];
  let connectionString = process.env['DATABASE_URL'] ?? '';
  let failOn: FailLevel = 'destructive';
  let format: 'text' | 'markdown' = 'text';
  let cautionRows = 100;
  let destructiveRows = 1000;

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;

    switch (argument) {
      case '--help':
      case '-h':
        return undefined;

      case '--url':
        connectionString = required(argv, ++i, '--url');
        break;

      case '--fail-on': {
        const level = required(argv, ++i, '--fail-on');
        if (!['destructive', 'blocking', 'caution', 'safe', 'never'].includes(level)) {
          throw new Error(`Unknown level for --fail-on: ${level}`);
        }
        failOn = level as FailLevel;
        break;
      }

      case '--format': {
        const chosen = required(argv, ++i, '--format');
        if (chosen !== 'text' && chosen !== 'markdown') {
          throw new Error(`Unknown format: ${chosen}`);
        }
        format = chosen;
        break;
      }

      case '--caution-rows':
        cautionRows = number(required(argv, ++i, '--caution-rows'), '--caution-rows');
        break;

      case '--destructive-rows':
        destructiveRows = number(required(argv, ++i, '--destructive-rows'), '--destructive-rows');
        break;

      default:
        if (argument.startsWith('-')) {
          throw new Error(`Unknown option: ${argument}`);
        }
        files.push(argument);
    }
  }

  if (files.length === 0) {
    return undefined;
  }
  if (connectionString.trim().length === 0) {
    throw new Error('No connection string. Pass --url or set DATABASE_URL.');
  }

  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`No such file: ${missing.join(', ')}`);
  }

  return {
    files,
    connectionString,
    failOn,
    format,
    thresholds: {
      cautionRows,
      destructiveRows,
      largeTable: 100_000,
      sampleSize: 5,
      // Off: a CI run measuring a migration should not also be running each
      // statement a second time to time it.
      explainAnalyze: false,
    },
  };
}

function required(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

function number(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} needs a non-negative number, got ${value}.`);
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** What to call the database in the report, without the password. */
function describeTarget(connectionString: string, engine: string): string {
  try {
    const url = new URL(connectionString);
    const name = url.pathname.replace(/^\//, '').split('?')[0];
    return `${name || engine}@${url.hostname}`;
  } catch {
    return engine;
  }
}
