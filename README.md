# Dry Run

See what a SQL statement will actually do to your data, before you run it for real.

> **Status: M2.** The rollback mechanism, the statement splitter, DML previews with before/after
> samples, all the DDL probes, and the panel are built and tested against a real Postgres —
> 121 tests. Safety hardening (M3) and the demo GIF (M4) are next. See
> [DRYRUN_SPEC.md](DRYRUN_SPEC.md) for the full plan.

## The problem

You write `ALTER TABLE users DROP COLUMN phone_number;` because you think nobody uses it.
You run it. 40,182 rows had a value. There is no undo.

Migration tools tell you *which statements will run*. None of them tell you *what those
statements will do to the data that is in the table right now*. Linters can pattern-match the
text of a `DROP COLUMN`, but they never connect to a database, so they cannot count anything.

## How it works

Postgres has transactional DDL, so a statement can be executed and then discarded:

```sql
BEGIN;
  <your statement>   -- really executes, the server reports real numbers
ROLLBACK;            -- nothing persists
```

The database does the actual work and reports the actual row count, then forgets it happened.
This is not an estimate or a simulation — it is a real execution that is thrown away.
Structural changes are the exception: those are measured with read-only counting queries
instead, because an index build takes its full time and its full lock whether it is rolled back
or not, and previewing it that way would cause the outage it is meant to prevent.

## Safety

- **Nothing is ever committed.** The rollback is in a `finally` block, so it happens when the
  analysis succeeds, when it throws, and when it times out. There is no `COMMIT` anywhere in the
  codebase — enforced by a lint rule and by a test that scans the source.
- **Transaction control in your SQL is refused.** A migration file containing a literal `COMMIT;`
  would otherwise persist everything the preview just did, so those statements are rejected
  before they reach the server.
- **Every transaction is bounded.** `statement_timeout` and `lock_timeout` are set on each one.
  A preview must never be the cause of a lock queue.
- **DDL is never executed**, not even inside a rolled-back transaction.
- **Production connections are refused**, not warned about. There is no one-click override; you
  add the connection to `dryrun.allowedConnections` in settings, or you don't connect.
- **Credentials are never stored.** The connection string is read from your environment or `.env`
  and held in memory only.
- **Sessions are tagged** as `vscode-dryrun` in `pg_stat_activity`, so a DBA can see exactly what
  these connections are and kill them.

## Limitations

- Postgres only. MySQL and MongoDB are on the roadmap, with a smaller feature set each, for the
  reasons in the spec.
- Results reflect the database you connect to. Pointed at an empty local dev database, every
  answer will be zero and none of them will be useful. Point it at staging or a replica.
- Index build times are estimates, and are labelled as estimates. Every other number is an exact
  count measured against your data.

## Setup

```bash
npm install
npm run compile
```

Set a connection string, either in a `.env` file at the workspace root:

```
DATABASE_URL=postgresql://user:password@localhost:5432/your_db
```

or in settings, as an environment-variable reference (never paste a password here):

```json
{ "dryrun.connectionString": "${env:DATABASE_URL}" }
```

Then press `F5` to launch the extension host and run **Dry Run: Test Connection**.

## Development

```bash
npm test        # compiles, then runs the suite against a real Postgres
npm run lint
npm run typecheck
```

The tests do not mock the database — the whole value proposition is real database behaviour, so
a mocked one would prove nothing. `embedded-postgres` downloads real Postgres binaries and runs a
throwaway cluster, which avoids requiring Docker on the dev machine.
