# sqlite-notes

A SQLite testbed: 500 notes in three notebooks, with tags hanging off them.

```
npm run testbed:sqlite
```

That writes `notes.db` and `.env` and exits. There is no server, no port and
nothing left running — which is the point of having SQLite here at all. It is
the engine where the whole setup takes two seconds.

Paste the printed `sqlite:` string into the Rehearsal sidebar, then open
`migrations/0001_tidy_notes.sql` and press `ctrl + alt + d`.

## What the data is shaped for

| | |
|---|---|
| 500 notes, 41 archived | a `DELETE` with something real to count |
| 12 notes with no title | a `NOT NULL` with twelve rows to refuse — except SQLite has no syntax for one, so it is refused by name instead |
| 62 notes sharing the slug `untitled` | a `CREATE UNIQUE INDEX` that cannot be built |
| every note and tag cascading | a cascade that Rehearsal counts but will not promise, because `PRAGMA foreign_keys` is off by default |

## The two things SQLite does differently

**It can take a schema change back.** An `ALTER TABLE` here runs inside a
transaction and a `ROLLBACK` really undoes it, exactly as on Postgres. So the
preview is a real execution, not a count — the promise MySQL cannot make.

**It has almost no `ALTER TABLE`.** Four operations: `ADD COLUMN`,
`DROP COLUMN`, `RENAME TO`, `RENAME COLUMN`. Retyping a column, adding a
constraint or making one `NOT NULL` do not exist, and Rehearsal refuses them
by name with what the twelve-step rebuild would take rather than exporting SQL
that fails on its first line.

Needs Node 22 or newer, which is where the built-in `node:sqlite` module
arrived.
