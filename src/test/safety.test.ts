import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Spec §10.1: there is no COMMIT anywhere in the codebase, and this is
 * enforced mechanically rather than by memory.
 *
 * Two files legitimately contain the word: the detector that exists to refuse
 * it, and its own tests. Everything else is scanned.
 */

const SRC = path.resolve(__dirname, '..', '..', 'src');

const ALLOWED = new Set([
  path.join('parser', 'transactionControl.ts'), // the detector itself
]);

function sourceFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sourceFiles(full, base);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Removes // and /* *\/ comments so prose about COMMIT does not trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, (line) => {
    const idx = line.indexOf('//');
    return line.slice(0, idx);
  });
}

describe('no COMMIT in the codebase', () => {
  it('finds source files to scan', () => {
    assert.ok(sourceFiles(SRC).length >= 5);
  });

  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file);
    if (ALLOWED.has(relative)) {
      continue;
    }

    it(`${relative} contains no COMMIT`, () => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));

      // Case-sensitive: SQL keywords are uppercase throughout this codebase,
      // so `COMMIT` is a statement while "previews never commit" is a sentence
      // in an error message. Matching prose case-insensitively would push the
      // wording around to satisfy the scanner, which is the tail wagging the
      // dog — the hazard is a COMMIT reaching the server, not the word.
      const keyword = /\bCOMMIT\b/.exec(code);
      assert.equal(
        keyword,
        null,
        `${relative} contains COMMIT — a preview must never persist anything.`,
      );

      // The lowercase spelling still matters in the one place it could do
      // damage: handed to something that executes it.
      const executed = /\b(?:query|execute|exec)\s*\(\s*[`'"]\s*commit\b/i.exec(code);
      assert.equal(
        executed,
        null,
        `${relative} passes a commit statement to a query call.`,
      );
    });
  }
});
