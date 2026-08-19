# Dry Run — build specification

A VS Code extension that shows you what a SQL query or migration will actually do to your
database, before you run it for real.

This document is the source of truth for the build. Read it fully before writing code.

---

## 1. The problem

Developers run destructive or expensive SQL without knowing the outcome in advance.

Four failure modes, all common, all expensive:

| Failure | Example | Cost |
|---|---|---|
| Silent data loss | `DROP COLUMN phone_number` on a column 40k rows actually use | Unrecoverable without a backup restore |
| Half-applied migration | `SET NOT NULL` on a column with 12 nulls | Migration fails mid-way, schema in an inconsistent state |
| Production lock | `CREATE INDEX` on a 2M-row table without `CONCURRENTLY` | Writes blocked, user-facing outage |
| Wrong blast radius | `UPDATE users SET tier='free'` with a broken `WHERE` | Thousands of rows silently wrong |

Existing tools do not solve this:

- Migration frameworks (Prisma, Drizzle, Alembic, Flyway) report *what statements will run*, never *what those statements will do to the data currently in the table*.
- ERD and schema-diagram extensions visualize structure. They know nothing about row counts or query cost.
- Query editors (DataGrip, TablePlus, pgAdmin) execute for real. The knowledge arrives after the damage.
- Linters (sqlfluff, squawk) pattern-match SQL text. They can warn "this is a `DROP COLUMN`" but cannot say "and 40,182 rows have a value in it," because they never connect to a database.

**The gap: nothing measures a pending statement against the real data it is about to hit.**

---

## 2. The mechanism

Relational databases support transactions. Inside a transaction you can execute a statement,
observe its full effect, then discard it.

```sql
BEGIN;
  -- capture before-state
  <the user's statement>          -- really executes
  -- capture after-state
ROLLBACK;                          -- nothing persists
```

The database performs the actual work and reports actual numbers, then forgets. This is not a
simulation or an estimate — it is a real execution that is thrown away.

**Postgres is the v1 target for one specific reason: it has transactional DDL.** `ALTER TABLE`,
`DROP COLUMN`, and `CREATE INDEX` can all be rolled back. MySQL commits DDL immediately and
cannot. That difference determines the roadmap in §11.

---

## 3. What the user sees

1. User opens a `.sql` file, or a migration file, or selects SQL in any file.
2. A panel opens beside the editor.
3. Each statement in the file becomes a row in the panel, color-coded by severity.
4. Each row states the concrete consequence: rows affected, rows that will break, table size, lock duration, estimated cost.
5. Destructive statements expand to show a before/after sample of actual rows.
6. Nothing has been committed. The user decides whether to run it for real.

The panel is the product. All value is delivered visually — a number and a color, next to
the line that causes it.

---

## 4. Scope

### v1 (must ship)

- Postgres only
- Statement-level analysis of `.sql` files and editor selections
- DML preview: `UPDATE`, `DELETE`, `INSERT` — real execution inside a rolled-back transaction, with before/after row samples
- DDL analysis: `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... SET NOT NULL`, `ALTER COLUMN ... TYPE`, `CREATE INDEX`, `ADD CONSTRAINT`, `TRUNCATE`, `RENAME`
- Severity classification per §7
- Webview panel per §9
- Safety guards per §10

### v2

- Query plan visualization (§8)
- Migration file support for Prisma, Drizzle, and raw numbered `.sql` directories
- MySQL adapter (§11)

### v3

- Code reference scan: "6 places in your codebase still read this column" (§12)
- MongoDB adapter

### Explicit non-goals

- Not a query editor. Dry Run never commits. There is no "run for real" button, ever. The user runs it through their normal tooling.
- Not a schema diagram tool. That space is saturated.
- Not a linter. No opinions about SQL style.
- Not a migration runner.

---

## 5. Architecture

```
src/
  extension.ts              activation, command registration, lifecycle
  parser/
    splitter.ts             split file text into statements + line ranges
    classifier.ts           statement -> StatementKind + extracted targets
  adapters/
    types.ts                DatabaseAdapter interface
    postgres.ts             v1 implementation
    mysql.ts                v2
  analysis/
    orchestrator.ts         runs each statement through the right analyzer
    dml.ts                  transactional execution + before/after capture
    ddl.ts                  pre-flight probe queries
    severity.ts             rule table -> Severity
  connection/
    manager.ts              connection resolution, pooling, disposal
    guard.ts                production detection, confirmation gating
  panel/
    controller.ts           webview lifecycle, message passing
    webview/                the UI bundle (see §9)
  test/
```

### The adapter interface

Every engine-specific behavior sits behind this. Nothing above `adapters/` may contain
Postgres-specific SQL.

```ts
interface DatabaseAdapter {
  readonly engine: 'postgres' | 'mysql' | 'mongo';
  readonly supportsTransactionalDDL: boolean;

  connect(config: ConnectionConfig): Promise<void>;
  dispose(): Promise<void>;

  // Runs fn inside a transaction that is ALWAYS rolled back.
  withRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // Probes that never modify anything.
  countRows(table: string, where?: string): Promise<number>;
  countNonNull(table: string, column: string): Promise<number>;
  countViolating(table: string, predicate: string): Promise<number>;
  tableStats(table: string): Promise<TableStats>;
  sampleRows(table: string, pks: PrimaryKeyValue[], limit: number): Promise<Row[]>;
  primaryKeyColumns(table: string): Promise<string[]>;
  explain(sql: string, analyze: boolean): Promise<QueryPlan>;
}
```

`withRollback` must roll back in a `finally` block. A thrown error inside `fn` must still
produce a rollback. This is the single most important correctness property in the codebase —
write the test for it first.

---

## 6. Analysis by statement kind

### 6.1 DML — real execution, discarded

For `UPDATE`, `DELETE`, `INSERT`:

```
BEGIN
  SET LOCAL statement_timeout = <configured>
  SET LOCAL lock_timeout = '2s'

  1. Resolve primary key columns of the target table.
  2. before := SELECT pk, * FROM <table> WHERE <predicate> LIMIT <sampleSize>
     Capture the full set of affected pks separately (SELECT pk ... no limit) if
     the count is under a configured ceiling; otherwise record the count only.
  3. Execute the user's statement. Record `rowCount` from the driver.
  4. after := SELECT * FROM <table> WHERE pk IN (<captured pks>)
     For DELETE, `after` is empty by definition — skip step 4.
     For INSERT, `before` is empty — capture the inserted pks via RETURNING.
  5. Diff before/after per column, per row. Record which columns changed.
ROLLBACK
```

Report:
- exact `rowCount`
- per-column change summary ("`tier`: 8,431 rows change from `pro` to `free`")
- a sample of N rows (default 20) with before and after values, changed cells highlighted
- warning if the statement has no `WHERE` clause at all

**Extracting the predicate:** do not attempt to re-derive the `WHERE` clause by string
manipulation for the `before` capture in the general case — subqueries, joins, and CTEs make
this unreliable. Preferred approach: use `RETURNING` where the engine supports it to capture
affected primary keys directly from the statement itself, then select the before-state from a
snapshot taken at transaction start. If `RETURNING` is unavailable for the statement shape,
fall back to count-only reporting and mark the sample as unavailable rather than showing a
sample that might be wrong. **A wrong sample is worse than no sample.**

### 6.2 DDL — probe, do not execute

DDL is analyzed with read-only probe queries. It is not executed even inside a rollback,
because some DDL takes the same real time and locks as the committed version (index builds
especially), which would make the preview itself an outage.

| Statement | Probe | Reports |
|---|---|---|
| `DROP COLUMN x` | `COUNT(*) WHERE x IS NOT NULL` | rows that lose data |
| `DROP TABLE t` | `COUNT(*) FROM t`, dependent FK lookup | rows lost, dependent tables |
| `SET NOT NULL` | `COUNT(*) WHERE x IS NULL` | rows that make it fail |
| `ALTER COLUMN TYPE` | `COUNT(*)` + cast-failure probe via `WHERE x::newtype IS NULL AND x IS NOT NULL` guarded by exception handling | rows that fail to cast, whether a rewrite is required |
| `ADD CONSTRAINT ... CHECK` | `COUNT(*) WHERE NOT (<check>)` | rows that violate it |
| `ADD FOREIGN KEY` | anti-join against the referenced table | orphan rows |
| `ADD UNIQUE` | `GROUP BY ... HAVING COUNT(*) > 1` | duplicate groups |
| `CREATE INDEX` | table size from `pg_class.reltuples` and `pg_total_relation_size` | estimated build time and lock duration, plus whether `CONCURRENTLY` is present |
| `TRUNCATE` | `COUNT(*)` | rows lost |
| `RENAME COLUMN/TABLE` | none (defer to code scan, v3) | flags that references may break |

Index build time is an estimate, and must be labeled as an estimate in the UI. Everything else
is an exact count. **Never present an estimate with the visual weight of a measured fact.**

---

## 7. Severity rules

```ts
type Severity = 'safe' | 'caution' | 'blocking' | 'destructive';
```

| Severity | Meaning | Color | Triggers |
|---|---|---|---|
| `destructive` | Data is permanently lost | red | `DROP COLUMN` with non-null count > 0; `DROP TABLE` with rows > 0; `TRUNCATE` with rows > 0; `DELETE` with no `WHERE`; `UPDATE`/`DELETE` affecting more than `destructiveRowThreshold` (default 1000) |
| `blocking` | The statement will fail or lock | red | `SET NOT NULL` with nulls > 0; constraint additions with violations > 0; type change with cast failures > 0; `CREATE INDEX` without `CONCURRENTLY` on a table over `largeTableThreshold` (default 100k rows) |
| `caution` | Succeeds, but worth a look | amber | `UPDATE`/`DELETE` affecting more than `cautionRowThreshold` (default 100); any table rewrite; `ALTER COLUMN TYPE` even when all rows cast cleanly |
| `safe` | No data impact | green | `ADD COLUMN` nullable; `CREATE TABLE`; `CREATE INDEX CONCURRENTLY`; `DROP COLUMN` where non-null count is 0; anything affecting 0 rows |

All thresholds live in settings. Severity is computed only after probes return — never from
SQL text alone. A `DROP COLUMN` on an empty column is `safe`, and the extension must say so
rather than crying wolf. Credibility is the product; false alarms destroy it.

---

## 8. Query plan (v2)

While the DML transaction is already open, also run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
on the statement. This is free — the connection and transaction already exist.

Render as a flame graph: node width proportional to actual time, not estimated cost.

Surface prominently:
- sequential scans on tables above `largeTableThreshold`
- nodes where `actual rows` diverges from `estimated rows` by more than 10x (stale statistics)
- the single most expensive node, called out by name

Do not reimplement plan rendering from scratch. Study `pev2` (BSD-licensed, Vue) for layout
approach; either embed it or build a simpler renderer using the same principles. Attribute
appropriately in the README.

---

## 9. The panel

A VS Code webview beside the active editor. This is the entire user-facing surface — treat it
as the primary deliverable, not an afterthought.

### Layout

```
┌─────────────────────────────────────────────────┐
│ [db icon] Migration impact   0007_update.sql    │  header: connection name, file
├─────────────────────────────────────────────────┤
│ ▌ [Will destroy data]  DROP COLUMN phone_number │  red left border
│   40,182 rows have a value here. Cannot be undone.
├─────────────────────────────────────────────────┤
│ ▌ [Will fail]  ALTER email SET NOT NULL         │  red left border
│   12 rows have no email. Migration stops halfway.
├─────────────────────────────────────────────────┤
│ ▌ [Will lock table]  CREATE INDEX ON orders     │  amber left border
│   2.1M rows. Writes blocked for roughly 40 seconds.
├─────────────────────────────────────────────────┤
│ ▌ [Safe]  ADD COLUMN last_seen_at               │  green left border
└─────────────────────────────────────────────────┘
```

### Rules

- One row per statement, in file order.
- Row = severity badge + the statement (monospace, truncated) + one plain-English consequence sentence.
- Consequence sentences state the number first. "40,182 rows have a value here" — not "This may affect data."
- Destructive and blocking rows expand on click to a before/after table.
- Clicking a row scrolls the editor to that statement's line. Bidirectional: moving the cursor highlights the matching row.
- Editor gutter decorations mirror the severity colors so the signal is visible without the panel focused.
- Use VS Code theme variables (`--vscode-*`) throughout. The panel must be legible in light, dark, and high-contrast themes. Never hardcode a hex color.
- Loading is per-row, not global. Rows resolve independently as their probes return — a slow count on one table must not block the whole panel.
- Errors are per-row too. A probe failure shows "couldn't analyze" on that row only, with the error available on hover.

### Before/after table

Two-column layout, one row per sampled record, changed cells highlighted. Show the primary key
so the user can identify the record. Cap at the configured sample size and state clearly:
"showing 20 of 8,431 affected rows."

---

## 10. Safety — non-negotiable

This extension connects to databases and executes statements. Getting this wrong causes exactly
the harm the tool exists to prevent. Every item below is mandatory.

1. **Always roll back.** `withRollback` rolls back in `finally`. No code path commits. There is
   no commit call anywhere in the codebase. Add a lint rule or a test that greps for it.

2. **Timeouts on every transaction.** `SET LOCAL statement_timeout` (default 5s, configurable)
   and `SET LOCAL lock_timeout` (2s, non-negotiable minimum). A preview must never be the cause
   of a lock queue.

3. **Never execute DDL**, even inside a transaction. Probes only. See §6.2.

4. **Production detection.** Before connecting, check the connection string against
   `dryrun.productionPatterns` (default: `/prod/i`, `/production/i`, `/live/i`). On a match:
   refuse to run, show a banner explaining why, and require the user to explicitly add that
   connection to `dryrun.allowedConnections` in settings. Never offer a one-click "connect
   anyway" button — the friction is the point.

5. **Tag the connection.** Set `application_name = 'vscode-dryrun'` so a DBA looking at
   `pg_stat_activity` can immediately identify and kill these sessions.

6. **Manual trigger by default.** Do not analyze automatically on file open in v1. The user
   invokes `Dry Run: Preview`. Auto-analyze-on-save can be added later behind a setting that
   defaults to off.

7. **Never store credentials.** Read connection config from `.env`, from an existing VS Code
   database extension's configuration, or from a user setting containing an env var reference.
   Never write a password to `settings.json`, never to workspace state. If a credential is
   needed and unavailable, prompt through `vscode.window.showInputBox` with `password: true`
   and hold it in memory only.

8. **Hard connection ceiling.** One connection, disposed when the panel closes. No pooling in
   v1. Registered in `context.subscriptions` so deactivation always cleans up.

9. **Kill switch.** A visible cancel control on the panel that aborts the in-flight query and
   rolls back immediately.

---

## 11. Engine roadmap

### Postgres (v1)
Transactional DDL and a mature `EXPLAIN`. Everything in this spec works natively.

### MySQL (v2)
No transactional DDL — DDL commits implicitly and cannot be rolled back. DML transactions work
fine, so §6.1 ports directly. For DDL, §6.2's probe-only approach already avoids execution, so
it also ports without change.

The optional enhancement for MySQL, when higher fidelity is needed: clone only the tables the
statement touches (`CREATE TABLE _dryrun_x LIKE x; INSERT INTO _dryrun_x SELECT * FROM x`),
run against the clones, then drop them. Constraints:
- Only viable below a configured row ceiling (suggest 500k). Above that, fall back to probes.
- Foreign keys referencing uncloned tables must be stripped from the clone or the clone must include the referenced tables transitively.
- Clones must use a reserved prefix and be dropped in a `finally`. Orphaned clones are a real hazard — add a startup sweep that drops any stale `_dryrun_*` tables older than an hour.
- Requires `CREATE TABLE` privilege, which many read-only analysis users will not have. Detect and degrade gracefully.

Ship probe-based MySQL first. Table cloning is a follow-up, and a good standalone post.

### MongoDB (v3)
Schemaless, so most DDL checks are meaningless — there are no columns to drop or constraints to
violate. What survives is the highest-value part: `updateMany`/`deleteMany` preview with real
counts and before/after document samples. Multi-document transactions exist on replica sets, so
the rollback mechanism works. Smaller feature surface, still useful.

---

## 12. Code reference scan (v3)

When a statement drops or renames a column or table, scan the workspace for source references
and report them: "`phone_number` is referenced in 6 files."

Scope it deliberately:
- ORM model/schema definitions (Prisma schema, Drizzle table definitions, SQLAlchemy models, Django models)
- Raw SQL string literals in source files
- Direct property access on known model types

Use `ripgrep` via VS Code's search API. Accept false positives; the panel presents these as
"possible references, check these," not as certainty. This is a hint layer, not analysis.

---

## 13. Tech choices

| Concern | Choice | Note |
|---|---|---|
| Language | TypeScript, strict mode | |
| Postgres driver | `pg` | |
| SQL parsing | `pgsql-ast-parser` or `node-sql-parser` | Evaluate both. Must handle statement splitting with dollar-quoted strings and comments correctly — this is the classic source of bugs. |
| Panel UI | Plain TypeScript + CSS, or Preact if state grows | No heavy framework. Bundle size matters for webview startup. |
| Bundler | esbuild | |
| Tests | `@vscode/test-cli` + `testcontainers` for a real Postgres | Do not mock the database. The entire value proposition is real database behavior. |
| Lint | ESLint + a custom rule banning `COMMIT` | |

---

## 14. Milestones

Each milestone must be independently demonstrable. Do not start the next until the current one
is complete and its acceptance criteria pass.

### M0 — foundation
- Extension scaffold, activates on `.sql` files
- Connection manager reads a Postgres URL from `.env` or a setting
- `withRollback` implemented
- **Acceptance:** a test proves that an `UPDATE` executed inside `withRollback` reports a correct `rowCount`, and that the row is unchanged after the function returns. A second test proves a thrown error inside the callback still rolls back.

### M1 — DML preview, panel v1
- Statement splitter with correct handling of comments, strings, and dollar quoting
- DML analysis with row counts and before/after samples
- Panel renders rows with severity colors, click-to-line both directions
- **Acceptance:** open a `.sql` file with an `UPDATE`, see the exact affected count and a sample of changed rows, with nothing committed to the database.

### M2 — DDL analysis
- All probes from §6.2
- Severity rules from §7
- Gutter decorations
- **Acceptance:** the four-row panel from §9 renders correctly against a seeded test database with the stated numbers.

### M3 — safety hardening
- Every item in §10 implemented and tested
- Production pattern detection with the refusal banner
- Cancel control
- **Acceptance:** connecting to a URL containing "prod" is refused. Every code path is verified to roll back. Timeouts fire correctly.

### M4 — polish and release
- README with a demo GIF as the first thing below the title
- Marketplace listing
- Error states for every failure mode: no connection, table not found, permission denied, timeout, unparseable SQL

Stop at M4. Ship it. v2 features are a separate cycle — a finished small extension beats three
half-built features.

---

## 15. Testing

Use `testcontainers` to spin up a real Postgres for the test suite. Seed it with a fixture
schema containing:
- a table with a partially-null column (for `SET NOT NULL`)
- a table with duplicate values (for `ADD UNIQUE`)
- a table with orphan rows (for `ADD FOREIGN KEY`)
- a large table, 100k+ rows (for size thresholds and index estimates)
- an empty column (to verify a `DROP COLUMN` correctly reports `safe`)

Priority test coverage, in order:
1. Rollback correctness under every path including thrown errors and timeouts
2. Statement splitter edge cases — semicolons inside strings, dollar-quoted function bodies, nested comments
3. Each probe returning the correct count against the fixture
4. Severity classification at threshold boundaries
5. Production-pattern refusal

---

## 16. README requirements

The README is a deliverable, not documentation. It is what a hiring manager reads.

Required, in this order:
1. One-sentence description
2. A demo GIF, under 10 seconds, showing a `DROP COLUMN` being flagged with a real row count
3. The problem, stated with a concrete example
4. How it works — the rollback mechanism, explained in three sentences
5. Limitations, stated plainly: Postgres only; results reflect the database you connect to, so point it at staging or a production replica rather than an empty local dev database; index build times are estimates
6. Safety guarantees, as a list
7. Setup

Write the limitations section honestly. An engineer reading a README that clearly states its own
boundaries trusts everything else in it more.

---

## 17. Open questions to resolve during M1

- Which SQL parser handles migration files from Prisma and Drizzle most reliably? Test both against real generated migration files before committing.
- For DML where `RETURNING` is not usable, is count-only acceptable, or is there a snapshot approach worth the complexity? Default to count-only and revisit only if it proves limiting in practice.
- Should the panel analyze the whole file or only the statement under the cursor by default? Whole file for migrations, cursor statement for ad-hoc `.sql` scratch files — decide based on file location heuristics, or make it a toggle in the panel header.
