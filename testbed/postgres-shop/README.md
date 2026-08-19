# postgres-shop

The Postgres testbed. A small e-commerce schema seeded with data shaped so that
every probe in spec §6.2 has something real to find, and a set of migration files
that each land on a different severity.

**Status: live.** This is the engine Dry Run v1 supports.

## Setup

```powershell
# from the repo root, after creating testbed/postgres-shop/.env
node testbed/postgres-shop/scripts/setup.mjs
```

The script drops and recreates its four tables, seeds them, runs `ANALYZE`, and
then prints what the panel should say for each migration file. That printout is
the acceptance check for M2 — if the panel disagrees with it, one of the two is
wrong.

Options: `--url "postgresql://…"`, `--users 50000`, `--orders 300000`.
Drop the counts to `--users 5000 --orders 20000` if you want a faster seed; the
findings stay the same shape, only the numbers shrink.

The script refuses to run against a host or database whose name looks like
production, on the same rule the extension uses. It drops tables, so that guard
is not decoration.

## What the data is hiding

| Table | Rows | What it is for |
|---|---|---|
| `users` | 50,000 | 12 null emails, 40 duplicate emails, 200 orphaned `org_id`, a mostly-populated `phone_number`, and a `nickname` that is null in every row |
| `orders` | 300,000 | large enough that an index build has a real cost; 150 orphaned `user_id`; refunds stored as `total_cents = 0` |
| `carts` | 5,000 | two thirds abandoned, for scoped-versus-unscoped `DELETE` |
| `orgs` | 8 | the referenced side of the foreign key that fails |

## The migration files

| File | Expected | Why it is here |
|---|---|---|
| `0001_add_last_seen.sql` | all safe | the baseline. If anything here is flagged, the rules are too eager |
| `0002_drop_phone_number.sql` | destructive | the original story: a column someone believes is unused |
| `0003_email_not_null.sql` | blocking | fails partway, leaving the schema half-migrated |
| `0004_index_orders.sql` | blocking | correct index, wrong build: no `CONCURRENTLY` on a large table |
| `0005_retire_free_tier.sql` | destructive → safe | three `UPDATE`s: huge, small, and one whose `WHERE` only looks scoped |
| `0006_add_constraints.sql` | blocking ×4 | foreign keys, a unique index, and a check — all with existing violations |
| `0007_update.sql` | red, red, amber, green | **the demo file**, matching the panel mockup in spec §9 |
| `0008_cleanup_carts.sql` | destructive → safe | a `DELETE` with no `WHERE`, a scoped one, one that matches nothing, and a deliberate error case |
| `0009_safe_changes.sql` | all safe | the credibility file — a tool that flags everything gets turned off |
| `parser_torture.sql` | 9 rows | not a migration: semicolons in strings, nested dollar quotes, nested comments. The M1 splitter fixture |

## A note on 0008 and 0009

`0008` ends with `TRUNCATE audit_log`, and `audit_log` is created by `0001`.
Because previews never commit, that table does not exist unless you have
actually applied `0001` for real. That row is *supposed* to fail — it is the
per-row error state from spec §9, and every other row in the file must still
resolve normally around it.

`0009` is the one worth staring at. Getting all-green right is harder than
getting red right, and it is what makes the red rows believable.
