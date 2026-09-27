# Roadmap

Every planned task, easiest first. Ticked items are done. The larger items have
a section of their own further down explaining what they are and why.

Nothing here requires anyone to pay for anything — where a paid service would
help, there is a free path first and the paid one is optional.

**One rule for all the interface work:** it stays native to VS Code. It inherits
the user's theme, font and colours. A webview that ignores the theme is the
thing that looks broken in VS Code.

## In order

- [x] 1. Sidebar: every engine named and coloured — SQLite was listed as MongoDB
- [x] 2. Schema explorer: fix the truncated row-search placeholder
- [x] 3. Sidebar: full connection name on hover
- [x] 4. Sidebar: keyboard shortcut shown on each action
- [x] 5. Accessible names on icon-only buttons
- [x] 6. Right-click "Preview with Rehearsal" in the editor and the explorer
- [x] 7. Editor title button on MongoDB operation files too
- [x] 8. A shortcut for Explore Schema
- [x] 9. Settings grouped: Connection / Safety / Engines / Experimental
- [x] 10. Visible keyboard focus in every panel
- [x] 11. Reduced motion respected in the diagram
- [x] 12. Preview: line references that look like the links they are
- [x] 13. Status bar: current connection and engine
- [x] 14. Switch connection from a quick pick
- [x] 15. Status bar: the last preview's verdict
- [x] 16. Preview: Run again
- [x] 17. Preview: progress while running, time taken when done
- [x] 18. Schema explorer: `/` focuses search, Esc closes the drawer
- [x] 19. Schema explorer: column buttons you can actually hit
- [x] 20. Schema explorer: counts out of the crowded toolbar
- [x] 21. Preview: Copy as Markdown
- [x] 22. Preview: the verdict stays visible while scrolling
- [x] 23. Preview: safe statements collapsed into one line
- [x] 24. Preview: filter by severity from the counts
- [x] 25. Preview: ↑/↓ between findings, Enter jumps to the line
- [x] 26. Preview: "Couldn't analyze" says where the error came from
- [x] 27. Empty states that say what to press
- [x] 28. Schema explorer: zoom buttons
- [x] 29. Sidebar: a dropped connection says so
- [x] 30. The safe-migration preamble (`lock_timeout` and retry)
- [x] 31. Sidebar: recent previews, one click to re-run
- [x] 32. Schema explorer: `ctrl + z` undoes the last pending change
- [x] 33. Schema explorer: remember dragged positions per database
- [x] 34. Contrast pass on small text, light and high-contrast themes
- [x] 35. Hover on a table name: rows, size, indexes
- [x] 36. CodeLens above each statement
- [ ] 37. Get Started walkthrough
- [ ] 38. Try it on a sample database — no setup, no credentials
- [ ] 39. Backup check before Apply
- [ ] 40. Will it run out of disk?
- [ ] 41. Dead column report
- [ ] 42. Constraints your data already satisfies
- [ ] 43. Partitioned and Timescale tables
- [ ] 44. WAL volume, and what it does to your replicas
- [ ] 45. ORM schema drift
- [ ] 46. Rehearse on a real copy
- [ ] 47. SQL Server
- [ ] 48. Query cost after the migration
- [ ] 49. Lock-queue replay

---

# Details on the larger items

## 1. Will it run out of disk?

`ALTER TABLE … TYPE` rewrites the table, so it needs two copies of it on disk
while it runs. An index build needs room for the index. Running out mid-way is
catastrophic, unrecoverable, and invisible today.

```
Will fail — orders is 21 GB and this rewrites it. The volume has 8 GB free.
```

**How:** table and index sizes are already read. Free space is one query on
Postgres (`pg_tablespace` plus the data directory, where the role can see it)
and MySQL (`information_schema.FILES`). Where free space cannot be read, say so
rather than assume there is enough.

**Why first:** the best ratio of damage prevented to lines written on this list.

## 2. Rehearse on a real copy

The feature the product is named after. Today it *previews*: every statement is
really executed and rolled back. A rehearsal goes further — copy the database,
apply the migration for real, measure the actual wall-clock and lock-hold time,
drop the copy.

That turns the one number still labelled *estimate* — how long the lock is held
— into a measurement.

**Free path:** on Postgres, `CREATE DATABASE scratch TEMPLATE yours` is a local
file copy, with no account and no service. **Optional:** a Neon or PlanetScale
branch, for people who already have one. It generalises the MySQL table copy
that already exists, from one table to the whole database.

**Hard part:** a template copy needs no other connections to the source, and a
large database takes real disk — which is why #1 comes first.

## 3. Constraints your data already satisfies

The inverse of everything the tool does now. Instead of *this constraint will
fail*, it says *this constraint would succeed, and you do not have it*:

- `users.email` is non-null on every one of 50,000 rows, and nullable
- `(org_id, slug)` is unique in practice and unconstrained
- `status` only ever holds four values

Every suggestion is pre-verified against the real data, which is the thing no
linter can claim. The probes already exist; this points them the other way.

## 4. The verdict on the line

A CodeLens above each statement and a hover on each table name, so the answer
is where the eye already is rather than in a panel you have to open.

```
40,072 rows · cascades to 2 tables · ACCESS EXCLUSIVE
ALTER TABLE users DROP COLUMN phone_number;
```

## 5. WAL volume, and what it does to your replicas

Measurable inside the rolled-back run: read `pg_current_wal_lsn()` before and
after and diff them. Then, where `pg_stat_replication` is readable:

```
Generates about 1.2 GB of WAL. Your replica applies roughly 8 MB/s —
expect around two and a half minutes of replication lag.
```

A real cause of "the migration finished and the site was still broken," and
nothing else measures it before the fact.

## 6. SQL Server

The fifth engine, and a genuinely different answer on the axis this project is
built around. SQL Server has transactional DDL like Postgres — so previews are
real executions — but its lock escalation, `ONLINE = ON` index builds and
`sp_rename` are its own, and its quoting is `[brackets]`.

**How:** `mssql` (the `tedious` driver, MIT, pure JavaScript — no native build,
no paid component). Free local server: SQL Server Developer Edition, or the
`mcr.microsoft.com/mssql/server` image where Docker is available. The adapter
contract, the dialect layer and the leak guard mean the work is one adapter,
one dialect and one testbed; the analysis layer should not need to learn it
exists.

**Honest caveat:** there is no embedded SQL Server the way there is an embedded
Postgres, so the test fixture needs either Docker or a local install. The suite
will skip the SQL Server tests, loudly, when neither is present.

---

## Smaller, whenever

- **The safe-migration preamble.** Offer to wrap the file in
  `SET LOCAL lock_timeout = '3s'` and a retry, so a migration that cannot get
  its lock fails fast instead of queueing everything behind it.
- **Backup check before Apply.** Read `pg_stat_archiver`: "your last WAL archive
  was 14 hours ago" is worth knowing before the irreversible button.
- **ORM schema drift.** The Prisma and Drizzle ledgers are already read. Parse
  the schema file too and diff it against the live database.
- **Dead column report.** Row counts, the code reference scan and index usage,
  combined into one *safe to drop?* verdict.
- **Partitioned and Timescale tables.** The snapshot carries a `partitioned`
  flag that nothing reads.

## Bigger swings

- **Lock-queue replay** from `pg_stat_statements`: what would have queued, and
  for how long.
- **Query cost after the migration**, using the rolled-back index build the
  index advisor already does.

## Deliberately not

- **An LLM explanation button.** It costs money per call, and it would put
  confident prose in a tool whose identity is measured numbers. If it ever
  appears, it is bring-your-own-key and visibly separate from the measurements.
- **A vscode.dev build.** It cannot open a database connection.
- **Generating migrations from an ORM diff.** Prisma and Drizzle already do it.
