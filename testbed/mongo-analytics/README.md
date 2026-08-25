# mongo-analytics

The MongoDB testbed. An events/sessions dataset.

**Status: live.** Dry Run connects to MongoDB, and `mongodb://` or
`mongodb+srv://` selects the adapter.

One condition, and it is not optional: previews need a **replica set**.
Multi-document transactions are what the rollback is, and a standalone
`mongod` does not have them — so Dry Run refuses to connect to one rather
than running a preview it could not undo. Atlas gives you a replica set on
the free tier, and a local single-node one works too.

## What survives the port, and what doesn't

Most of Dry Run's DDL analysis is meaningless here. There are no columns to
drop, no `NOT NULL` to add, no foreign keys to violate. Schemalessness removes
the entire category.

What survives is the part with the highest value anyway:

- `updateMany` and `deleteMany` previews, with a real count and a real
  before/after document sample.
- The rollback mechanism itself, because Mongo has multi-document transactions.

That is a smaller feature surface than Postgres gets, and it is still useful —
a `deleteMany` with a filter that is subtly wrong is exactly as expensive in
Mongo as it is in SQL, and nothing warns you first.

## The one hard requirement

**Transactions need a replica set.** A plain local `mongod` is a standalone and
does not support them, which means there is no way to roll a preview back, which
means Dry Run must refuse to run there rather than execute something it cannot
undo. Atlas's free M0 tier is a three-node replica set, so it works.

The seed script checks this and tells you which one you have.

## Setup

```powershell
npm install --save-dev mongodb
node testbed/mongo-analytics/scripts/setup.mjs --url "mongodb+srv://user:pass@cluster.mongodb.net/analytics"
```

## The data

| Collection | Documents | What it is hiding |
|---|---|---|
| `events` | 200,000 | a third have `user_id: null`; a fifth carry a `legacy_utm` field nothing reads any more; revenue is zero on most |
| `sessions` | 40,000 | a quarter never ended, which is what makes a cleanup `deleteMany` risky |
