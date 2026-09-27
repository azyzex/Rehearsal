#!/usr/bin/env node
/**
 * Builds a SQLite testbed and writes its .env.
 *
 *   npm run testbed:sqlite
 *
 * The cheapest of the four by a wide margin: there is no server to start, no
 * port to pick and nothing to leave running. It writes a file and exits, which
 * is also the point of having SQLite in here at all — it is the engine where
 * the whole thing takes two seconds to set up.
 *
 * The data is shaped to make the interesting answers appear:
 *
 *   - 41 of the 500 notes are archived, so a DELETE has something to count.
 *   - 12 notes have no title, so a NOT NULL has twelve rows to refuse.
 *   - every note belongs to a notebook with ON DELETE CASCADE, so the cascade
 *     report has something to say — including that it may not happen at all,
 *     because PRAGMA foreign_keys is off unless a connection turns it on.
 *   - 62 notes share a slug, so a unique index has duplicates to find.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, '..');
const DB = path.join(PROJECT, 'notes.db');

const NOTES = 500;

async function main() {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    console.error(
      'This needs Node 22 or newer, which is where the built-in node:sqlite\n' +
        `module arrived. You are on ${process.version}.`,
    );
    process.exit(1);
  }

  // Rebuilt from scratch every time. A testbed that accumulates state across
  // runs stops being a testbed: the numbers in the panel drift and you cannot
  // tell a real change from yesterday's leftovers.
  rmSync(DB, { force: true });
  rmSync(`${DB}-journal`, { force: true });
  mkdirSync(PROJECT, { recursive: true });

  const db = new sqlite.DatabaseSync(DB);

  db.exec(`
    CREATE TABLE notebooks (
      id      integer PRIMARY KEY,
      name    text NOT NULL,
      colour  text DEFAULT 'slate'
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
  `);

  db.exec(`
    INSERT INTO notebooks (id, name, colour) VALUES
      (1, 'Work', 'amber'), (2, 'Personal', 'slate'), (3, 'Archive', 'grey');
  `);

  const note = db.prepare(
    'INSERT INTO notes (notebook_id, title, slug, body, words, archived) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const tag = db.prepare('INSERT INTO tags (note_id, tag) VALUES (?, ?)');

  db.exec('BEGIN');
  for (let i = 1; i <= NOTES; i += 1) {
    note.run(
      1 + (i % 3),
      // Twelve with no title at all, for the NOT NULL to refuse.
      i % 41 === 0 ? null : `Note ${i}`,
      // Sixty-two sharing a slug, for a unique index to trip over.
      i % 8 === 0 ? 'untitled' : `note-${i}`,
      `Body of note ${i}. `.repeat(3 + (i % 5)),
      20 + (i % 180),
      i % 12 === 0 ? 1 : 0,
    );
    if (i % 3 === 0) {
      tag.run(i, ['idea', 'todo', 'reference'][i % 3]);
    }
  }
  db.exec('COMMIT');

  const counts = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM notes)                      AS notes,
         (SELECT count(*) FROM notes WHERE archived = 1)   AS archived,
         (SELECT count(*) FROM notes WHERE title IS NULL)  AS untitled,
         (SELECT count(*) FROM tags)                       AS tags`,
    )
    .all()[0];

  db.close();

  const url = `sqlite:${DB.split(path.sep).join('/')}`;
  writeFileSync(
    path.join(PROJECT, '.env'),
    `# Written by: npm run testbed:sqlite\n` +
      `# A file, not a server. Rehearsal opens it, previews inside a transaction\n` +
      `# and rolls back, so nothing you preview here is kept.\n` +
      `DATABASE_URL=${url}\n`,
    'utf8',
  );

  console.log(`SQLite testbed ready: ${DB}`);
  console.log(
    `  ${counts.notes} notes, ${counts.archived} archived, ` +
      `${counts.untitled} with no title, ${counts.tags} tags`,
  );
  console.log('');
  console.log('Paste this into the sidebar:');
  console.log(`  ${url}`);
  console.log('');
  console.log('Nothing is left running. Delete notes.db to start over.');
}

await main();
