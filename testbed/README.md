# Testbed

Three sample projects to develop and demo Dry Run against. None of them is
packaged into the extension — `testbed/` is excluded from the `.vsix`.

| Project | Engine | Status |
|---|---|---|
| [`postgres-shop`](postgres-shop/) | Postgres | **live** — this is what v1 supports |
| [`mysql-blog`](mysql-blog/) | MySQL | staged for v2 |
| [`mongo-analytics`](mongo-analytics/) | MongoDB | staged for v3 |

Each one is seeded with data that is *deliberately messy* — nulls where a
`NOT NULL` is about to be added, orphans where a foreign key is about to be
created, a column that looks unused but isn't. Clean test data would make every
preview say zero, and prove nothing.

---

## Why a cloud database rather than a local one

Two reasons, and one caveat.

**Latency is part of the product.** A probe that returns in 0.2 ms locally takes
40 ms from a cloud region, and the panel's per-row loading behaviour (spec §9:
rows resolve independently, a slow count on one table must not block the rest)
only actually gets tested when the counts are slow enough to see.

**It's the realistic pointing.** The README tells people to point Dry Run at
staging or a replica, not at an empty local dev database. Testing it the way it
will be used surfaces things — SSL, connection limits, cold starts — that a
local socket never will.

**The caveat:** it's slower to iterate against. The automated test suite still
uses a local throwaway Postgres via `embedded-postgres`, and always will. The
cloud database is for driving the extension by hand and recording the demo.

---

## Setting up Postgres on Neon

Neon is free, needs no credit card, and gives you a plain Postgres connection
string. Roughly two minutes.

> The project used while building this is called `dryrun-testbed`, on Postgres 18
> in `us-east-1`. The steps below are what to repeat from scratch — and worth
> reading anyway for the two settings that matter, in steps 2 and 5.

### 1. Create the project

1. Go to **https://neon.com** and sign up (GitHub or Google is fastest).
2. You'll land on **Create project**. The defaults are fine, but set:
   - **Project name** — `dryrun-testbed`
   - **Postgres version** — 17
   - **Region** — pick the one nearest you. This is the latency you'll be
     testing against, so somewhere realistic rather than somewhere fast.
3. Click **Create**.

### 2. Copy the connection string

The dashboard shows a **Connection string** box straight after creation. It
looks like:

```
postgresql://neondb_owner:npg_XXXXXXXX@ep-cool-name-a1b2c3d4.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Two things to check before you copy it:

- There's a **Pooled connection** toggle. Leave it **off**. Dry Run opens one
  connection and holds a transaction open on it; a pooler in transaction mode
  can hand your statements to a different backend and quietly break that.
- Keep the `?sslmode=require` on the end. Neon refuses plaintext connections,
  and without it you'll get a confusing handshake error rather than a clear one.

If you've navigated away: **Dashboard → your project → Connect**, and pick
**Connection string**, **psql** or **Parameters only** — any of them shows it.

### 3. Point the seeder at it

Create `testbed/postgres-shop/.env` (copy `.env.example`) and paste the string
in as `DATABASE_URL`. Then, from the repo root:

```powershell
node testbed/postgres-shop/scripts/setup.mjs
```

It creates the schema, seeds ~355,000 rows, runs `ANALYZE`, and prints a table
of what the panel should say for every migration file. Expect 30–90 seconds
depending on region.

### 4. Point the extension at it

Create a `.env` at the **repo root** as well — that's the one the extension
reads — with the same `DATABASE_URL`. Then press <kbd>F5</kbd> and run
**Dry Run: Test Connection** from the command palette in the new window.

### 5. Resetting between tests

Previews never commit, so ordinary use never dirties the data. But if you apply
a migration for real and want to get back:

- Re-run `setup.mjs` — it drops and recreates everything. Simplest.
- Or use Neon's **branching**: create a branch off `main` before you experiment,
  point at the branch, and delete it when you're done. Instant, and it's the
  feature that makes Neon worth choosing here.

---

## Things that will bite you

**Neon suspends idle projects.** On the free tier a project that's been quiet
for ~5 minutes scales to zero. The next connection wakes it, which takes a few
seconds. If your first **Test Connection** feels slow or times out, run it again
— that's a cold start, not a bug. It's also worth knowing when you record the
demo GIF: warm the database up first with one throwaway preview.

**The extension will refuse some hostnames.** Dry Run blocks connection strings
matching `prod`, `production`, or `live`. Neon hostnames are randomly generated,
so if you're unlucky enough to get `ep-prod-something`, that's the guard working
correctly — either add the `host:port/database` to `dryrun.allowedConnections`
in settings, or just create a new project.

**An SSL deprecation warning is expected, and harmless.** `sslmode=require`
works as-is — the driver enables TLS and verifies Neon's certificate against the
system CAs, which is stricter than `require` technically demands. Node will
print a warning saying that `require` is currently treated as an alias for
`verify-full` and won't be in `pg` v9. Nothing to fix today; when we pin `pg` v9
we switch the string to `sslmode=verify-full` and the behaviour is unchanged.

**Free tier limits.** 0.5 GB storage, which the default seed uses maybe 15% of.
If you crank `--users` and `--orders` up an order of magnitude to test the large
table thresholds properly, keep an eye on it.

**Don't commit the `.env` files.** Both are gitignored. Worth double-checking
before the first push, because a leaked Neon string is a live database.

---

## Free databases for the other two engines

Not needed yet — noted here so the decision doesn't have to be made twice.

- **MySQL (v2):** PlanetScale dropped its free tier, so most guides you'll find
  are out of date. **Aiven** has a genuinely free MySQL plan; **Railway** gives a
  monthly credit that covers a test database comfortably.
- **MongoDB (v3):** **Atlas M0** is free and, importantly, is a three-node
  replica set. That matters — Mongo needs a replica set for the multi-document
  transactions the rollback mechanism depends on, and a local standalone
  `mongod` can't do it.
