# Dry Run

See what a database change will actually do to your data, before you do it.

> **Status: working, not yet published.** 1,053 tests: against a real Postgres, a
> real MySQL and a real MongoDB, plus 168 that render the panels in a browser and
> click them. The demo recording and the marketplace listing are the remaining
> work.

<!-- DEMO: replace this line with the GIF. Under 10 seconds: open 0007_update.sql,
     press Ctrl+Alt+D, land on four rows — red, red, amber, green — with the real
     40,072 on the first one. -->

## Installing it

```
npm install
npm run vsix
code --install-extension dryrun-0.0.1.vsix
```

Then click the database icon in the activity bar. Paste a connection string and
it works out the rest — `postgresql://`, `mysql://` and `mongodb://` each pick
their own adapter, and a string with no scheme is read from its port. Connections
you keep go in the OS keychain; only their labels are written to disk, so the
list can be drawn without ever touching a credential.

Press `f5` instead if you are changing the code — that launches a second window
running from source.

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

**Know whether it will queue.** Every other number assumes the statement runs
unobstructed. Postgres queues lock requests fairly, so a DDL statement waiting
behind a long-running reader becomes the head of a queue that every later query
joins — including reads that conflict with nothing. That is how a routine
`ADD COLUMN` takes a site down for twenty minutes. Each statement reports the
lock it takes, what that blocks, and who is holding a conflicting one right now.

**See what a delete takes with it.** `DELETE FROM users WHERE id = 5` is one row
in the statement and an unknown number across tables it never names. The cascade
is walked and counted at every level, with `ON DELETE SET NULL` reported
separately as the quieter surprise.

**Get the safer form.** A statement that would lock a table for the length of a
scan is offered the Postgres pattern that avoids it — `CONCURRENTLY` for an index,
`NOT VALID` then `VALIDATE` for a constraint, the three-step route for
`SET NOT NULL`. Suggested only when the measurement says it is needed, with one
click to replace it in the file.

**See the plan.** Turn on `dryrun.explainAnalyze` and each `UPDATE`, `DELETE` and
`INSERT` also carries its query plan, with node widths drawn from time actually
spent rather than estimated cost — a plan drawn by cost shows what the planner
believed, and the interesting cases are where it believed wrong. Sequential scans
on large tables and estimates that are ten times out are called out by name. It is
off by default because `EXPLAIN ANALYZE` runs the statement a second time.

**Show me which rows.** A blocking count is a starting point, not an answer:
"12 rows have no email" tells you that you are stuck, not which twelve or what
they should be. Blocking findings carry a button that fetches exactly those rows
— the nulls, the orphans, the duplicates with their group members sitting
together — along with a statement that would clear them. Where only you can
decide what a value should become, the statement comes with the decision left as
a hole to fill rather than something quietly invented.

**Would an index help?** `Dry Run: Would an Index Help?` (`ctrl + alt + i`) reads
the plan for the query under your cursor, finds the sequential scans, works out
which columns the filters actually test, and then — this is the part every other
tool skips — tests each candidate index against the planner and reports whether
the planner would reach for it. On a database with `hypopg` the index is never
built: it exists only in the planner's head, so the answer takes milliseconds on
a table of any size and takes no lock at all. Without `hypopg` it offers to build
each one inside a transaction it rolls back, which measures real milliseconds at
the price of a real build. Either way nothing is kept, and an index the planner
ignores is reported as ignored — a suggestion that costs write throughput
forever is worth refusing.

**Answer the question your ORM would not.** `Dry Run: Preview Pending
Migrations` finds your migrations — Prisma, Drizzle, or a plain folder of `.sql`
files — asks the database which of them it has already run, and previews the
rest. Prisma and Drizzle both hand you generated SQL and then warn about it
without a number in the warning: *possible data loss*, *you are about to drop a
column*. Possible how, losing what? Neither tool goes and looks, because neither
wants to connect to production to generate a migration. This does, read-only,
and replaces the warning with a count. It also reports drift the other way: a
migration the database has run that is not in your checkout usually means this
is not the environment you thought it was.

**See where the weight sits.** The diagram will colour itself by a measurement:
rows, size on disk, dead rows waiting on vacuum, rows changed since the planner
last looked, or foreign keys with no index behind them. Shaded by rank rather
than by value, because table sizes are almost always a power law and a linear
scale paints one table red and everything else the same shade of nothing.

**Read the schema's own health.** `Dry Run: Schema Health Report` writes a
markdown document: foreign keys with nothing behind them (with the
`CREATE INDEX CONCURRENTLY` that fixes each one), indexes another index already
covers, indexes nothing has read, and tables whose statistics the planner can no
longer trust. Every section leads with the window the statistics cover — "this
index has never been scanned" and "this index has not been scanned since the
server woke up ninety seconds ago" are the same number, and only one of them is
a reason to drop anything.

**Know what else fired.** The preview really executes the statement, so
triggers really run — which is a feature: the row counts already include
whatever they did. It becomes a problem in exactly one case, and Dry Run now
says so loudly. A rollback takes back rows. It does not take back a
notification already sent, a row pushed through a foreign data wrapper, or an
HTTP request already answered. Trigger functions are read one level deep for
those, and the panel says plainly that one level deep is not a proof.

**Ask the code, not just the database.** The database will let you drop a column
the moment nothing *in the database* depends on it. The application is never
consulted, and the application is where the outage lands — the migration
succeeds, the deploy succeeds, and forty minutes later something serialises a
row and finds a field missing. Findings that remove something carry a "where
does the code use this?" button that searches the workspace, in every spelling
an ORM might have given it: `phone_number`, `phoneNumber`, `PhoneNumber`,
`phone-number`. Finding nothing is reported as *finding nothing by text search*,
never as safe.

**Find the drift between two environments.** `Dry Run: Compare With Another
Database` reads both schemas and writes what the second one is missing or has
extra: tables, columns, types, nullability, defaults, foreign keys. Phrased as
work to do rather than as a set of differences, because "these differ" is not
actionable and "add this column to staging" is. Foreign keys are compared by
what they connect rather than by name, since constraint names drift between
environments for no interesting reason. The second connection is opened for the
comparison, read-only, and closed again; the string is never saved and its
password never reaches the report.

**In the Problems view too.** Every finding is also published as an editor
diagnostic, so it lands in the Problems panel, the file's ruler, the tab's
badge, and whatever you have bound to "go to next problem" — none of which
needed building, and all of which people check out of habit. Safe statements
draw nothing: twenty hints for twenty harmless statements teaches you to
collapse the section. They clear the moment the file is edited, because a
measurement describes the statement that produced it and an edited line no
longer contains it.

**Remember what was applied.** Applying used to leave no trace outside the
database itself. `Dry Run: Applied Changes` now lists what ran, against which
database, when, and what the preview said before it ran — each entry holding the
rescue file and the down migration that were generated for it. Nothing on that
list executes anything: getting back means opening the file and previewing it
like anything else, which keeps the property the whole extension rests on.

**Keep a copy of what you destroy.** Applying is the one irreversible thing this
extension does, so before it runs anything destructive it writes the rows that
are about to be lost to `.dryrun/rescue-<timestamp>.sql` — the actual rows, as
statements that put them back — and opens the file before the confirmation, not
after. If the capture hits its cap the confirmation says so, because a rescue
file believed to be complete and isn't is worse than none at all.

**Explore the schema.** `Dry Run: Explore Schema` draws the whole database —
every table, every relationship, laid out so that the shape of the schema is
visible before you have read a name. Drag tables where you want them, search
across table and column names, click one to isolate its relationships, and use
focus mode to show only what sits within a few joins of it.

**Find a route.** Open a table and pick another: it traces the shortest path
through the foreign keys and hands you the JOIN. Knowing that `users` reaches
`products` through `orders` and `order_items` is only half of what you wanted;
the other half is not having to write it out.

**Change it visually.** Click a table to open it: columns, indexes, constraints,
and the first rows of real data. Rename a column, drop one, add one, flip its
nullability, change its type, edit a cell, delete a row. Add a table, drop one,
rename one. Each becomes a *pending change* — not a write. Then:

- **Now / After changes** flips the diagram between the schema as it is and the
  schema your changes ask for.
- **Preview** runs those changes against your real data — really executed, inside
  a transaction that is rolled back — and reports what each one would cost.
- **Apply** is the only thing that writes, and it refuses anything that has not
  been previewed exactly as it stands.
- **Export SQL** hands you the whole thing as a migration file to review and keep.
- **Down SQL** hands you the migration that undoes it — generated now, against
  the live schema, because "later" is after the change has been applied and by
  then the schema no longer remembers the column's type or its default. That is
  why hand-written down migrations are usually wrong. Anything it cannot undo is
  listed at the top of the file in plain words rather than quietly omitted.

## In CI

The same analysis runs without an editor, which is worth having because a pull
request is where a destructive migration is cheapest to catch — before anyone
has deployed anything. A review that says "this looks fine" is a guess; a check
that says "this DELETE matches 40,072 of 50,000 rows on the real database" is
not.

```
node dist/cli.js migrations/0002_drop_phone_number.sql
```

```
migrations/0002_drop_phone_number.sql — measured against neondb

DESTRUCTIVE line 1  Will destroy data
            40,072 rows have a value in phone_number. Dropping it cannot be undone.

1 would destroy data. Out of 1 statement.
```

Exit code 1. `--fail-on blocking` also fails on anything that would lock or
error, `--fail-on never` reports without failing, and `--format markdown` writes
a table a pull request can render. `examples/dryrun.yml` is a GitHub Action that
measures only the migrations a PR adds and puts the result in the job summary.

Point it at a restored copy of production, or a per-PR database branch. The
credential it needs is read-only: there is no flag that applies anything, on
purpose — a CI job holding a connection string that can write is a worse thing
to leave lying around than any migration it might have caught.

## Three databases, three answers

The extension rests on one property: everything runs inside a transaction that
is rolled back. Each engine answers that differently, and the differences are
enforced in code rather than described in a comment.

| | Data changes | Schema changes | Preview needs | Which rows changed |
|---|---|---|---|---|
| **Postgres** | roll back | roll back | nothing special | `RETURNING`, exact |
| **MySQL** | roll back | **commit silently** — refused by the adapter | nothing special | read before and after |
| **MongoDB** | roll back | **refused by the server** | a replica set | read before and after |

One number differs between them on purpose. An `UPDATE` that matches five rows
where one already holds the new value is five on Postgres and MySQL, which
rewrite every matched row, and four on MongoDB, which reports `modifiedCount`.
Both are true about their own engine. It is the only place the same migration
gets two different answers, so it is written down rather than left to be found.

The last column is the one that surprised me. Postgres learns exactly which rows
a statement touched by appending `RETURNING` — including rows a join dragged in,
which the `WHERE` clause alone would never reveal. Neither of the other two has
it, so both ask the question before the fact: read the rows the filter matches,
run the statement, read the same keys back. That is honestly worse in exactly
one case — a joined `UPDATE` on MySQL, where the sample says so — and better in
another, because on MongoDB the before and after rows are the same documents by
construction rather than by inference.

## MySQL, and the thing it cannot do

Postgres has transactional DDL: an `ALTER` inside a transaction is undone by a
`ROLLBACK` like anything else. MySQL does not — it performs an implicit commit
before *and* after every DDL statement, so an `ALTER` sent inside a transaction
is committed the instant it runs and the `ROLLBACK` that follows undoes nothing.

That is the one assumption this whole extension rests on, absent. So it is
enforced rather than documented: the MySQL adapter's `withRollback` refuses DDL
outright, the same way it refuses `COMMIT`, because the statements passed to it
come out of migration files and a file containing an `ALTER` would otherwise be
applied for real while the panel said nothing was committed. A test proves the
refusal is load-bearing by sending the same `ALTER` straight down the driver and
watching it survive a `ROLLBACK`.

Almost nothing else changes, and that is not luck. DDL was already analysed by
counting rather than by executing — an index build takes its full time and its
full lock whether it is committed or not — so every DDL finding was already a
read-only probe, and those probes work here unchanged.

What genuinely differs is **Apply**. A changeset is meant to be all or nothing;
on MySQL a changeset containing DDL cannot be, because the second statement
commits the first. So it is refused, with the suggestion to export the SQL and
run it through a migration tool that can record how far it got. Half a migration
is the exact failure this extension exists to prevent, and delivering one
quietly would be worse than not offering Apply at all.

## MongoDB, and the schema that is not written down

MongoDB gets the rule right by itself: try to create an index inside a
transaction and the server refuses. So the discipline the MySQL adapter has to
impose by hand is one this database already enforces.

What it adds instead is a condition neither SQL engine has. Multi-document
transactions require a replica set — point Dry Run at a standalone `mongod` and
there is no rollback available at all, so a preview would apply every change
permanently while reporting it as previewed. The adapter checks on connect and
refuses to work. A preview that cannot be rolled back is an apply with a
reassuring name.

Two things work differently because MongoDB is not a relational database:

**The schema is sampled, not read.** A collection is whatever its documents
happen to contain, so the field list comes from sampling and a field is reported
as nullable when documents are missing it. A field holding both strings and
integers is shown as holding both, because a schema explorer that picks one is
lying quietly.

**Relationships are measured, not declared.** There are no foreign keys. What
there is instead is fields named like references — `user_id`, `userId` — whose
values are usually the `_id` of another collection. So the naming suggests a
candidate and a count decides it: a field whose values are overwhelmingly
present in another collection is a relationship, whatever the database thinks,
and one that matches a tenth of the time just shares a name. Every one is
labelled as inferred.

Deleting works differently too. MongoDB does not cascade, so a delete removes
exactly what it matches — and the panel reports the referencing documents
anyway, because "these 40,000 documents now point at nothing" is the same
problem arriving by a different route.

Migrations are read rather than run. Dry Run reads the declarative subset —
`db.users.updateMany({ … }, { … })` and friends — and refuses anything with a
variable or a loop in it, because running your migration to find out what it
means is exactly the thing this tool exists not to do. A `$unset` applied across
a collection is read as what it is: dropping a column.

### The same file, measured against a real MySQL

```
testbed/mysql-blog/migrations/0001_cleanup.sql — measured against dbdata@127.0.0.1

DESTRUCTIVE line 1  Will destroy data
            1,600 rows have a value in twitter. Dropping it cannot be undone.

ok          line 2  Safe
            Every row already has a value in email. This will apply cleanly.

BLOCKING    line 3  Will fail
            40 rows share a duplicate email, across 1 value.

BLOCKING    line 4  Will fail
            150 rows in posts reference author_id values that are not in authors.

caution     line 5  Locks the table briefly
            comments has about 19,784 rows (1.5 MB). Writes are blocked for roughly 1
            second. Adding ALGORITHM=INPLACE, LOCK=NONE builds it without blocking
            writes, and fails outright if this index cannot be built that way.

ok          line 6  Safe
            legacy_bio is empty in all 2,000 rows. Nothing is lost.

ok          line 7  Safe
            This matches no rows at all. Nothing changes.

DESTRUCTIVE line 8  Will destroy data
            2,222 rows are deleted from comments.

2 would destroy data, 2 would fail or lock. Out of 8 statements.
```

Every line there is measured. Lines 2 and 3 are MySQL's own spelling —
`MODIFY … NOT NULL` and `ADD UNIQUE KEY` — and line 5's advice is MySQL's, not
Postgres's. That distinction exists because running this file for the first time
produced two "not analysed" rows and a recommendation that is a syntax error on
the database it was given about.

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
- **Credentials never touch the disk in plain text.** A string you do not save is
  read from your environment or `.env` on every connect and held in memory only.
  One you save with **Remember this one** goes to `SecretStorage`, which is the
  OS keychain; only its label is written to extension storage, so the saved list
  can be drawn without a credential being read at all.
- **Sessions are tagged** `vscode-dryrun` in `pg_stat_activity`, so a DBA can see
  what these connections are and kill them.

## Limitations

Stated plainly, because a README that hides them makes the rest less believable.

- **The three engines answer differently, and two of them answer less.** All
  three are implemented; what changes is how much the preview can promise. On
  Postgres a schema change is really executed and really rolled back. MySQL
  commits DDL implicitly, so schema changes there are measured by counting and
  never run, and a changeset containing one cannot be applied as a single unit.
  MongoDB needs a replica set for transactions at all — against a standalone
  server it refuses to preview rather than running something it could not take
  back. See the table above for which is which.
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
- **Large schemas still crowd the diagram.** Focus mode (show only what is within
  N relationships of a table) makes them workable, but the automatic layout does
  not route edges around cards, so a dense schema needs some dragging.

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

Then click the database icon in the activity bar and connect. Everything below
is also on the command palette, and `f5` launches a second window running from
source if you are changing the code.

| Command | What it does |
|---|---|
| `Dry Run: Preview` (`ctrl + alt + d`) | Analyse the open `.sql` file |
| `Dry Run: Explore Schema` | Draw the database, and edit it |
| `Dry Run: Preview Pending Migrations` | Measure what your ORM has queued up |
| `Dry Run: Schema Health Report` | Unindexed keys, unread indexes, stale statistics |
| `Dry Run: Compare With Another Database` | Drift between two environments |
| `Dry Run: Applied Changes` | What was applied, with its rescue file and down migration |
| `Dry Run: Would an Index Help?` (`ctrl + alt + i`) | Test an index against the planner |
| `Dry Run: Test Connection` | Check the connection alone |
| `Dry Run: Disconnect` | Close the connection |

In the explorer, **Export** writes the schema as a Mermaid ER diagram — GitHub
renders it natively, so it can live in a README and stay readable in a diff.

### Settings

The defaults are the ones to leave alone. The two worth knowing about are
`productionPatterns`, which is what refuses to connect to anything that looks
like production, and `explainAnalyze`, which is off because it doubles how long
a preview takes.

| Setting | Default | What it does |
|---|---|---|
| `dryrun.connectionString` | `""` | Postgres connection string. Use an environment variable reference such as `${env:DATABASE_URL}` — never paste a password here. Leave empty to read `DRYRUN_DATABASE_URL` or `DATABASE_URL` from a `.env` file in the workspace root. |
| `dryrun.envFile` | `".env"` | Path (relative to the workspace root) of the .env file to read the connection string from. |
| `dryrun.productionPatterns` | `["prod", "production", "live"]` | Case-insensitive regular expressions. If a connection string matches any of them, Dry Run refuses to connect. |
| `dryrun.allowedConnections` | `[]` | Connections that are exempt from production detection, written as `host:port/database`. Adding an entry here is a deliberate act — there is no one-click override. |
| `dryrun.statementTimeoutMs` | `5000` | statement_timeout applied inside every preview transaction. |
| `dryrun.lockTimeoutMs` | `2000` | lock_timeout applied inside every preview transaction. A preview must never be the cause of a lock queue. |
| `dryrun.sampleSize` | `20` | How many affected rows to show in a before/after sample. |
| `dryrun.cautionRowThreshold` | `100` | Rows affected above which a statement is marked 'caution'. |
| `dryrun.destructiveRowThreshold` | `1000` | Rows affected above which a statement is marked 'destructive'. |
| `dryrun.largeTableThreshold` | `100000` | Row count above which a table is treated as large for lock and index-build warnings. |
| `dryrun.explainAnalyze` | `false` | Capture a query plan for each UPDATE, DELETE and INSERT. This runs the statement a **second time** inside the same rolled-back transaction, so it roughly doubles how long a preview takes on a large statement. Off by default for that reason. |

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
