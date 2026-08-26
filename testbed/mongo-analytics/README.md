# mongo-analytics

The MongoDB testbed. Six collections and about 690,000 documents, shaped like a
document database rather than like a relational one with different words.

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

The short way, which needs nothing but this repository:

```powershell
npm run testbed:mongo
```

That starts a local single-node replica set, seeds it, writes the `.env`, and
prints a connection string to paste into the sidebar. Against Atlas instead:

```powershell
node testbed/mongo-analytics/scripts/setup.mjs --url "mongodb+srv://user:pass@cluster.mongodb.net/analytics"
```

Sizes are overridable when the full set is more than you want to wait for:
`--events 20000 --sessions 5000` and so on.

## The data

| Collection | Documents | What it is hiding |
|---|---|---|
| `accounts` | 500 | an embedded `billing` subdocument; `card_last4` is *missing* on free plans rather than null |
| `integrations` | ~1,250 | `config` holds a different shape per provider — five types wearing one field name |
| `users` | 60,000 | twelve per cent have no email, half null and half missing; the last 400 point at an account that does not exist |
| `sessions` | 150,000 | embedded `device` and `geo`; a quarter never ended |
| `orders` | 80,000 | an array of embedded `items`, and `total` is a double on some documents and an int on others |
| `events` | 400,000 | a third have `user_id: null`; a fifth carry a `legacy_utm` nothing reads; `props` is polymorphic by event type |

## What only this database can hold

Every one of these is a shape the two SQL testbeds cannot express, and each is
here because it is a thing the schema explorer has to render honestly:

- **Subdocuments, three levels deep.** `users.profile.preferences.notifications.email`
  is one field with a dotted name, which is how MongoDB addresses it and how it
  has to appear on the card.
- **Arrays of embedded documents.** `orders.items` is what replaces a join
  table — which means a single `$unset` on it destroys what SQL would need a
  cascade to reach.
- **Polymorphic fields.** There is no column type that describes `events.props`,
  and an explorer that picks one is lying.
- **One field, two types.** `orders.total` is a double on newer documents and an
  int on older ones. Ordinary here, impossible in a column.
- **Missing versus null.** Both mean "no value", and only this database can tell
  them apart — which is why the rescue file's filter asks for present *and* not
  null rather than just not null.
- **Relationships that are a convention, not a constraint.** There are no
  foreign keys. Dry Run infers all seven by looking at how far the values
  overlap, and draws them as inferences.

Three of the reference fields are deliberately left unindexed, so the schema
health report has something true to find rather than a clean bill on a database
nobody has ever used.
