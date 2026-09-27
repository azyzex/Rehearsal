-- A migration for the SQLite testbed, written to land on every answer SQLite
-- can give — including the three it cannot.
--
-- Preview it with ctrl + alt + d. Nothing here is applied: every statement runs
-- inside a transaction that is rolled back, which on SQLite covers the schema
-- changes too. That is the half MySQL cannot do.

-- Deletes rows, and reaches further than it says: tags has ON DELETE CASCADE
-- back to notes. Whether it really cascades depends on PRAGMA foreign_keys,
-- which is off by default — Rehearsal counts the rows and says it cannot
-- promise they go.
DELETE FROM notes WHERE archived = 1;

-- Twelve notes have no title, so this one cannot apply. It is also a change
-- SQLite has no syntax for at all: there is no ALTER COLUMN here, and the
-- documented route is a twelve-step table rebuild.
-- ALTER TABLE notes ALTER COLUMN title SET NOT NULL;

-- Sixty-two notes share the slug 'untitled', so the index cannot be built.
CREATE UNIQUE INDEX notes_slug ON notes (slug);

-- Fine, and instant: SQLite has ADD COLUMN.
ALTER TABLE notes ADD COLUMN pinned integer NOT NULL DEFAULT 0;

-- Also fine. An index build here holds the write lock for its whole duration,
-- against anything else with the file open.
CREATE INDEX notes_words ON notes (words);

-- Rewrites every row that matches, and the count is exact.
UPDATE notes SET words = words + 1 WHERE notebook_id = 1;
