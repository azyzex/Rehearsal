# Dry Run

See what a database change will actually do to your data, before you do it.

> **Status: working, not yet published.** 225 tests, all against a real Postgres.
> The demo recording and the marketplace listing are the remaining work.

<!-- DEMO: replace this line with the GIF. Under 10 seconds: open 0007_update.sql,
     press Ctrl+Alt+D, land on four rows — red, red, amber, green — with the real
     40,072 on the first one. -->

## The problem

You write `ALTER TABLE users DROP COLUMN phone_number;` because you're fairly sure
nobody uses it. You run it. 40,072 rows had a value. There is no undo.

Migration tools tell you *which statements will run*. None of them tell you what
those statements will do to the data that is in the table right now. Linters
pattern-match the text of a `DROP COLUMN`, but they never connect to a database,
so they cannot count anything. Query editors tell you — after it has happened.

## What it does

**Preview a migration.** Open a `.sql` file and press `ctrl + alt + d`. Every
statement becomes a row, colour-coded, each stating its consequence as a number:

```
WILL DESTROY DATA   ALTER TABLE users DROP COLUMN phone_number
  40,072 rows have a value in phone_number. Dropping it cannot be undone.
  ████████████████████░░░░░  80% of ~50,000 rows

WILL FAIL           ALTER TABLE users ALTER COLUMN email SET NOT NULL
  12 rows have no email. The migration stops here, partway applied.

WILL LOCK THE TABLE CREATE INDEX idx_orders_status ON orders (status)
  Estimate — orders has about 300,000 rows (24 MB). Writes are blocked for
  roughly 1 second. Adding CONCURRENTLY avoids the lock entirely.

SAFE                ALTER TABLE users ADD COLUMN last_seen_at timestamptz
  Adding a nullable column touches no existing rows.
```

`UPDATE` and `DELETE` rows expand to show the affected records as they are and
as they would become, with the changed cells highlighted.

**Explore the schema.** `Dry Run: Explore Schema` draws the whole database —
every table, every relationship, laid out so that the shape of the schema is
visible before you have read a name. Drag tables where you want them, search
across table and column names, click one to isolate its relationships.

**Change it visually.** Click a table to open it: columns, indexes, constraints,
and the first rows of real data. Rename a column, drop one, add one, flip its
nullability, edit a cell, delete a row. Each becomes a *pending change* — not a
write. Then:

- **Now / After changes** flips the diagram between the schema as it is and the
  schema your changes ask for.
- **Preview** runs those changes against your real data — really executed, inside
  a transaction that is rolled back — and reports what each one would cost.
- **Apply** is the only thing that writes, and it refuses anything that has not
  been previewed exactly as it stands.
- **Export SQL** hands you the whole thing as a migration file to review and keep.

## How it works

Postgres has transactional DDL, so a statement can be executed and then thrown
away:

```sql
BEGIN;
  <your statement>   -- really executes; the server reports real numbers
ROLLBACK;            -- nothing persists
```

The database does the actual work and reports the actual row count, then forgets
it happened. This is not an estimate or a simulation.

Getting the *before* and *after* of an `UPDATE` without re-deriving its `WHERE`
clause uses a savepoint: run the statement with `RETURNING` to capture the
affected primary keys, read the new rows, roll back to the savepoint, read the
old rows. Both halves are real reads matched by key, with nothing inferred.

Structural changes are the exception. An index build takes its full time and its
full lock whether it is rolled back or not, so previewing one that way would
cause the outage it exists to prevent. Those are measured with read-only counting
queries instead.

## Safety

- **Previewing never commits.** The rollback is in a `finally` block, so it
  happens when the analysis succeeds, when it throws, and when it times out.
- **One file can commit.** `adapters/commit.ts`, reachable only through Apply,
  which refuses statements whose preview does not match. Everywhere else a
  `COMMIT` is banned by a lint rule *and* a test that scans the source.
- **Transaction control in your SQL is refused.** A migration file containing a
  literal `COMMIT;` would otherwise persist everything the preview just did.
- **Every transaction is bounded.** `statement_timeout` and `lock_timeout` on all
  of them. A test holds an exclusive lock on a table and asserts the preview
  gives up rather than joining the queue — a preview must never be the reason a
  lock queue forms.
- **DDL is never executed** while measuring, not even inside a rollback.
- **Production connections are refused**, matched against the connection's
  identity rather than its password. There is no one-click override; you add the
  connection to `dryrun.allowedConnections`, or you don't connect.
- **Applying anything destructive is confirmed twice**, the second time in a
  modal that cannot be dismissed by muscle memory.
- **Credentials are never stored.** The connection string is read from your
  environment or `.env` on every connect and held in memory only.
- **Sessions are tagged** `vscode-dryrun` in `pg_stat_activity`, so a DBA can see
  what these connections are and kill them.

## Limitations

Stated plainly, because a README that hides them makes the rest less believable.

- **Postgres only.** MySQL and MongoDB are scaffolded but not implemented. MySQL
  commits DDL implicitly, so only the DML half of the mechanism ports; Mongo needs
  a replica set for the transactions this depends on.
- **Results reflect the database you connect to.** Pointed at an empty local dev
  database, every answer is zero and none of them are useful. Point it at staging
  or a replica.
- **Index build times are estimates**, and are labelled as estimates wherever they
  appear. Every other number is an exact count measured against your data.
- **The projected "after" schema is a projection, not a promise.** It says what
  your changes are asking for. Whether they succeed is what Preview answers — a
  `SET NOT NULL` projects perfectly and still fails against twelve null rows.
- **A sample can be unavailable.** If a table has no primary key, affected rows
  cannot be identified, so the count is still exact and the sample says it is
  missing. A wrong sample is worse than none.
- **Large schemas crowd the diagram.** Past roughly thirty tables the layout needs
  a focus mode that does not exist yet.

## Setup

```bash
npm install
npm run compile
```

Point it at a database, either with a `.env` at your workspace root:

```
DATABASE_URL=postgresql://user:password@localhost:5432/your_db
```

or in settings, as an environment-variable reference — never a pasted password:

```json
{ "dryrun.connectionString": "${env:DATABASE_URL}" }
```

Press `F5` to launch the extension host, then:

| Command | What it does |
|---|---|
| `Dry Run: Preview` (`ctrl + alt + d`) | Analyse the open `.sql` file |
| `Dry Run: Explore Schema` | Draw the database, and edit it |
| `Dry Run: Test Connection` | Check the connection alone |
| `Dry Run: Disconnect` | Close the connection |

## Development

```bash
npm test        # compiles, then runs against a real Postgres
npm run lint
npm run typecheck
```

There is a testbed with three sample projects and a seeded 21-table schema:

```bash
npm run testbed:db     # local Postgres, seeded, no signup
```

See [testbed/README.md](testbed/README.md) for the cloud path.

The tests do not mock the database. The entire value proposition is real database
behaviour, so a mocked one would prove nothing — `embedded-postgres` downloads
real Postgres binaries and runs a throwaway cluster, which avoids requiring
Docker.

## Where this diverged from its spec

[DRYRUN_SPEC.md](DRYRUN_SPEC.md) is the original design, kept as written. Two
things changed on contact with reality, both deliberately:

**It has an Apply button.** The spec said, in bold, that there would never be one.
Adding visual editing made that untenable — an editor that cannot save is a
viewer. So the safety property moved rather than disappearing: it is no longer
"the tool cannot write", it is "the tool cannot write anything whose measured
consequences you have not already been shown". The commit lives alone in one
file, behind a preview token that invalidates the moment you change anything.

**It draws schema diagrams**, which the spec explicitly warned against as a
saturated niche. It stands because it is not a schema tool that happens to show
changes — it is a change tool that happens to draw the schema. Every other ERD
extension shows you the same picture whatever you are about to run.
