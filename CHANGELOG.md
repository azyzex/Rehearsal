# Changelog

## 0.0.1 — unreleased

The first version. Not published yet.

### What it does

Reads a migration, runs each statement against your real data inside a
transaction that is rolled back, and tells you what it would have done. The
numbers are counts, not estimates: 40,072 rows lose a value, twelve rows have
no email and will stop a `NOT NULL`, this delete reaches three tables the
statement never mentions.

- **Preview** a `.sql` file, or a MongoDB operations file, against the database
  you are connected to.
- **Explore the schema** as a diagram you can edit, with the changes previewed
  before they are applied.
- **Would an index help?** — tested against the planner, and against the real
  timing where the engine allows an index to be built and rolled back.
- **Schema health**, **pending migrations**, **applied changes**, and
  **compare with another database**, each as a document you can keep.
- A **CLI** for CI, which fails the build on what you tell it to.

### Three engines

Postgres, MySQL and MongoDB, and the differences between them are enforced in
code rather than described in a comment. Postgres rolls a schema change back;
MySQL commits it the moment it runs, so schema changes there are measured by
counting and never executed; MongoDB needs a replica set for transactions at
all and refuses to preview without one.

On MySQL, a schema change can optionally be measured by running it against a
copy of the table rather than by counting — off by default, because it is the
only thing here that writes. What it buys is the server's own sentence
("Duplicate entry 'dupe@example.com' for key 'one_email'") in place of a total,
and it catches failures counting misses. The copy is dropped in a `finally`, and
swept on the next connect if a crash left one behind.

Each is written in its own language throughout — dropping a field is `$unset`
rather than `DROP COLUMN`, MySQL is quoted with backticks, and the route
between two collections is a `$lookup` pipeline rather than a JOIN.

### Safety

- Previewing never commits. The rollback is in a `finally`.
- DDL is never executed while measuring, on any engine.
- Production connections are refused unless explicitly allowed, one at a time.
- Applying anything destructive is confirmed twice, the second time in a modal.
- A rescue file of the rows a change destroys is written before it runs.
- Credentials go to the OS keychain or nowhere.
