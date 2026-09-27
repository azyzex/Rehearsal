import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A database to try Rehearsal on, built in a second, with nothing to install.
 *
 * The first thing a new user meets is a box asking for a connection string —
 * which means credentials, a server, and a reason to trust the tool with them
 * before having seen it do anything. SQLite needs none of that: this writes a
 * small file into the extension's own storage, and the first preview someone
 * ever sees has real numbers in it within ten seconds of installing.
 *
 * The data is shaped so every kind of answer appears: rows a DELETE removes,
 * rows a NOT NULL would refuse, duplicates a unique index cannot be built over,
 * and a cascade that may or may not be enforced.
 */

export interface Sample {
  readonly database: string;
  readonly migration: string;
}

export const SAMPLE_MIGRATION = `-- A sample migration, to see what Rehearsal does before pointing it at your own
-- database. Nothing here is applied: every statement runs inside a transaction
-- that is rolled back.
--
-- Press ctrl + alt + d (cmd + alt + d on a Mac), or use the links above each
-- statement.

-- Deletes rows, and reaches further than it says: tags cascade from notes.
DELETE FROM notes WHERE archived = 1;

-- Sixty-two notes share the slug 'untitled', so this index cannot be built.
CREATE UNIQUE INDEX notes_slug ON notes (slug);

-- Fine, and instant.
ALTER TABLE notes ADD COLUMN pinned integer NOT NULL DEFAULT 0;

-- Rewrites every note in one notebook. The count is exact.
UPDATE notes SET words = words + 1 WHERE notebook_id = 1;

-- Destroys data that exists: every note has a body.
ALTER TABLE notes DROP COLUMN body;
`;

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

/** Builds the sample into `directory`, replacing any earlier one. */
export function buildSample(directory: string): Sample {
  let sqlite: { DatabaseSync: new (file: string) => SqliteDatabase };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqlite = require('node:sqlite') as typeof sqlite;
  } catch {
    throw new Error(
      'The sample database is SQLite, which needs the built-in node:sqlite module from ' +
        'Node 22 or newer. This editor runs an older Node, so connect to a database of ' +
        'your own instead.',
    );
  }

  fs.mkdirSync(directory, { recursive: true });
  const database = path.join(directory, 'notes.db');
  const migration = path.join(directory, 'tidy_notes.sql');

  // Rebuilt every time, so trying it twice shows the same numbers twice.
  for (const leftover of [database, `${database}-journal`, `${database}-wal`]) {
    fs.rmSync(leftover, { force: true });
  }

  const db = new sqlite.DatabaseSync(database);
  try {
    db.exec(`
      CREATE TABLE notebooks (
        id     integer PRIMARY KEY,
        name   text NOT NULL,
        colour text DEFAULT 'slate'
      );
      CREATE TABLE notes (
        id          integer PRIMARY KEY,
        notebook_id integer NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        title       text,
        slug        text,
        body        text,
        words       integer NOT NULL DEFAULT 0,
        archived    integer NOT NULL DEFAULT 0
      );
      CREATE INDEX notes_notebook ON notes (notebook_id);
      CREATE TABLE tags (
        note_id integer NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag     text NOT NULL
      );
      INSERT INTO notebooks (id, name, colour) VALUES
        (1, 'Work', 'amber'), (2, 'Personal', 'slate'), (3, 'Archive', 'grey');
    `);

    const note = db.prepare(
      'INSERT INTO notes (notebook_id, title, slug, body, words, archived) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tag = db.prepare('INSERT INTO tags (note_id, tag) VALUES (?, ?)');

    // Fast without a transaction: nothing here needs to survive a power cut,
    // and an explicit transaction would mean the one word only commit.ts is
    // allowed to write. A scratch file is not worth the exception.
    db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
    for (let i = 1; i <= 500; i += 1) {
      note.run(
        1 + (i % 3),
        i % 41 === 0 ? null : `Note ${i}`,
        i % 8 === 0 ? 'untitled' : `note-${i}`,
        `Body of note ${i}. `.repeat(3 + (i % 5)),
        20 + (i % 180),
        i % 12 === 0 ? 1 : 0,
      );
      if (i % 3 === 0) {
        tag.run(i, ['idea', 'todo', 'reference'][i % 3]);
      }
    }
  } finally {
    db.close();
  }

  fs.writeFileSync(migration, SAMPLE_MIGRATION, 'utf8');
  return { database, migration };
}
