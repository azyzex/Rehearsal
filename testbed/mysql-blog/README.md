# mysql-blog

The MySQL testbed. A blog schema with the same hidden problems as
`postgres-shop`, in an engine that behaves differently enough to matter.

**Status: live.** Dry Run connects to MySQL, and `mysql://` in a connection
string is what selects the adapter.

## What is different about MySQL

MySQL commits DDL implicitly. `ALTER TABLE` cannot be rolled back, so the core
mechanism — run it, look at what happened, throw it away — does not apply to
schema changes at all.

What survives the port:

- **DML previews work unchanged.** `UPDATE` and `DELETE` inside a transaction
  roll back exactly as they do in Postgres, so §6.1 needs no new thinking.
- **DDL analysis works unchanged too**, because §6.2 already refuses to execute
  DDL and uses read-only counting queries instead. The probes are the same
  queries with different catalog views.

So the MySQL adapter is mostly a translation job, not a redesign. That is worth
knowing before starting it, and it is the reason the adapter interface exists in
`src/adapters/types.ts` from day one.

The higher-fidelity option — cloning the touched tables, running against the
clones, dropping them — is written up in spec §11, along with the three ways it
bites: orphaned clones, foreign keys pointing at uncloned tables, and needing
`CREATE TABLE` privilege that a read-only analysis user will not have. Probes
first; cloning is a follow-up.

## Setup

```powershell
npm install --save-dev mysql2
node testbed/mysql-blog/scripts/setup.mjs --url "mysql://user:pass@host:3306/blog"
```

The seed script has been run against a real MySQL. It is slow at the default
sizes — 400,000 comments — so pass `--authors 2000 --posts 6000 --comments
20000` for a quick one; the findings keep their shape and only the numbers
shrink. It was written before `mysql2` was
deliberately not in `package.json` — v1 does not need it, and an unused driver
in the bundle is dead weight.

## Free MySQL, when you need one

PlanetScale dropped its free tier, so the usual answer is out of date. Current
options: **Aiven** has a free MySQL plan, and **Railway** gives a monthly credit
that comfortably covers a test database. Both hand you a connection string in
the same shape. See `testbed/README.md` for how to point the extension at it.
