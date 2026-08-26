import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * SQL written where nobody knows which engine will read it.
 *
 * This exact bug has now appeared five times, in five different files, and
 * every one of them looked like a clean result rather than a broken query:
 *
 *   - a MySQL migration reported *safe* when it would have failed, because
 *     `"email" IS NULL` asks whether the constant 'email' is null;
 *   - a rescue file — the copy taken before the one irreversible act — full of
 *     exactly the rows the filter exists to exclude, and on MongoDB missing
 *     altogether;
 *   - an offending-rows scan that found nothing on a table full of offences;
 *   - an exported migration that MySQL rejects on the first line;
 *   - a join route handed to a MySQL user as a query MySQL will not run.
 *
 * The shape is always the same: a module that does not know the engine builds a
 * fragment of SQL, and Postgres is the only engine it is ever tested against.
 * So this reads the source and refuses the shape rather than waiting for a
 * sixth instance of it.
 *
 * It is deliberately crude. A regex over source text cannot know intent, which
 * is why the allowlist below is explicit and short: each entry is a file that
 * is *supposed* to write one engine's SQL, and saying so out loud is the point.
 */

/** A newline, built rather than escaped. */
const NEWLINE = String.fromCharCode(10);

/**
 * The opening of a template literal that is nothing but a quoted identifier.
 *
 * Built from character codes rather than written out, because a backtick and
 * a dollar-brace inside a TypeScript template literal need escaping and an
 * escape that goes missing turns this check into one that always passes —
 * which is exactly what the first version of it did.
 */
const BACKTICK = String.fromCharCode(96);
const QUOTED_IDENT_OPEN = BACKTICK + '"' + String.fromCharCode(36) + '{';

/**
 * Every place a file returns a double-quoted identifier.
 *
 * Scanned textually rather than with a regex, for the same reason.
 */
function ansiQuoters(source: string): number[] {
  const found: number[] = [];
  let at = source.indexOf(QUOTED_IDENT_OPEN);

  while (at !== -1) {
    const closes = source.indexOf(BACKTICK, at + QUOTED_IDENT_OPEN.length);
    const body = closes === -1 ? "" : source.slice(at + 1, closes);

    // The whole template is `"${something}"` and nothing else: a value that
    // *is* an identifier, rather than a sentence that quotes one.
    if (/^"\$\{[^}]*\}"$/.test(body)) {
      const before = source.slice(Math.max(0, at - 12), at);
      if (/(?:return|=>)\s*$/.test(before)) {
        found.push(at);
      }
    }

    at = source.indexOf(QUOTED_IDENT_OPEN, at + 1);
  }

  return found;
}

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Files allowed to spell out one engine's SQL, and why.
 *
 * Anything not on this list either does not build SQL or asks the engine how.
 */
const ALLOWED = new Map<string, string>([
  [
    'src/edit/changeset.ts',
    'The SQL renderer itself. Both spellings live here as named strategies, and ' +
      'the dialect picks one — that is what the ANSI-only version got wrong.',
  ],
  [
    'src/edit/rescueWriter.ts',
    'One writer per engine, side by side on purpose so the filter and the ' +
      'statement it pairs with cannot drift apart again.',
  ],
  [
    'src/edit/down.ts',
    'The SQL down migration. Its MongoDB counterpart is mongoDown.ts, and ' +
      'dialect.ts chooses.',
  ],
  [
    'src/analysis/joinPath.ts',
    'Holds both spellings and is handed the engine.',
  ],
  [
    'src/analysis/dml.ts',
    'The Postgres DML path, reached only when the engine is Postgres. MySQL ' +
      'goes to mysqlDml.ts and MongoDB to mongoDml.ts.',
  ],
  [
    'src/analysis/indexAdvice.ts',
    'Hypothetical indexes are a Postgres feature. The other two adapters ' +
      'refuse testIndex by name rather than reaching this.',
  ],
  [
    'src/analysis/rewrite.ts',
    'Every rewrite in it is Postgres syntax, and `rewritesFor` returns an ' +
      'empty list for any other engine before reaching one.',
  ],
  [
    'src/analysis/offenders.ts',
    'Asks the adapter how to quote and takes the MongoDB path when there is ' +
      'no answer. The SQL below that point runs only on an engine that has it.',
  ],
  [
    'src/migrations/ledger.ts',
    'Reads the migration table Prisma and Drizzle keep, which is a SQL table ' +
      'by construction. Discovery only offers a ledger for a project that has ' +
      'one, and the caller reports a failure rather than assuming an answer.',
  ],
  [
    'src/analysis/healthReport.ts',
    'The fix it suggests is chosen per engine by `indexFix`, which is why all ' +
      'three spellings appear in it.',
  ],
]);

/** Every .ts file under src, excluding tests and the adapters themselves. */
function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Adapters are where engine-specific SQL belongs, by definition.
        if (entry.name === 'test' || entry.name === 'adapters') {
          continue;
        }
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        found.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  };

  walk(path.join(ROOT, 'src'));
  return found;
}

/** Removes comments, so prose about SQL is not read as SQL. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('SQL written where the engine is not known', () => {
  const files = sourceFiles();

  it('reads the source at all', () => {
    assert.ok(files.length > 20, `only found ${files.length} files`);
    assert.ok(files.includes('src/edit/changeset.ts'));
  });

  it('has an accurate allowlist', () => {
    // An entry for a file that no longer exists is an entry nobody rechecked.
    for (const allowed of ALLOWED.keys()) {
      assert.ok(
        fs.existsSync(path.join(ROOT, allowed)),
        `${allowed} is allowlisted and does not exist`,
      );
    }
  });

  it('defines no ANSI identifier-quoter outside the files allowed to', () => {
    // The precise shape all five bugs had: a little helper that wraps a name
    // in double quotes, living in a file that does not know the engine. Every
    // one of them was written because it looked local and harmless.
    //
    // Deliberately narrower than "any string containing a double quote" —
    // sentences quote things too, and a check that cries wolf earns an
    // allowlist entry rather than a fix.
    const offenders: string[] = [];

    for (const file of files) {
      if (ALLOWED.has(file)) {
        continue;
      }

      const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));

      for (const at of ansiQuoters(source)) {
        const line = source.slice(0, at).split(NEWLINE).length;
        offenders.push(`${file}:${line}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'these quote an identifier for Postgres in code that runs on every engine — ' +
        'ask the adapter, or take a quoting strategy the way the dialect does',
    );
  });

  it('writes no bare ALTER TABLE, DROP TABLE or SELECT outside them either', () => {
    // The statement keywords, as opposed to the quoting. A module that builds
    // one of these without knowing the engine is building it for Postgres.
    const offenders: string[] = [];
    const keywords = /\b(ALTER TABLE|DROP TABLE|CREATE INDEX|INSERT INTO|SELECT \*|IS NOT NULL|IS NULL)\b/;

    for (const file of files) {
      if (ALLOWED.has(file)) {
        continue;
      }

      const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        // Only inside a template literal or a string being built, which is what
        // "generating SQL" looks like. A type name or an identifier that
        // happens to contain the words is not interesting.
        if (!/[`'"]/.test(line)) {
          return;
        }
        if (keywords.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 80)}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      'these build SQL in code that runs on every engine — ask the dialect instead',
    );
  });
});
