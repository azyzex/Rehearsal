// The Mongo equivalent of a migration file: write operations someone is about
// to run against real data.
//
// Every one of these is here because the count is not guessable from the text.
// Open this file with the testbed connected and run Dry Run: Preview.

// Destructive, and the number is the point: a fifth of 400,000 documents carry
// this field. There is no schema to consult afterwards to find out what was in
// it.
db.events.updateMany({ legacy_utm: { $exists: true } }, { $unset: { legacy_utm: '' } });

// The blast-radius case, and the one that only exists in this database.
// `{ user_id: null }` matches a document holding null *and* a document with no
// user_id at all, so this reaches a third of the collection — around 133,000 —
// when the author almost certainly meant only the ones missing the field.
db.events.deleteMany({ user_id: null });

// What they probably meant: about 44,000, a third of the other number. The gap
// between the two is the whole reason to look before running it.
db.events.deleteMany({ user_id: { $exists: false } });

// Reaches into a subdocument three levels down. In SQL this is a column; here
// it is a path, and it has to be quoted or it is a syntax error.
db.users.updateMany(
  { 'profile.preferences.notifications.digest': 'never' },
  { $set: { 'profile.preferences.notifications.digest': 'weekly' } },
);

// The one with no relational equivalent. `items` is an array of embedded
// documents — what replaces a join table — so this single operation reaches
// what SQL would need a second table and a cascade to touch.
db.orders.updateMany({ status: 'refunded' }, { $unset: { items: '' } });

// A field that holds two types. Older orders stored an integer number of cents
// and newer ones a float of currency units, and this only converts the ones
// that are already doubles.
db.orders.updateMany({ total: { $type: 'double' } }, [
  { $set: { total: { $convert: { input: '$total', to: 'int', onError: '$total' } } } },
]);

// Orphans. The last 400 users point at an account that does not exist, which is
// what a foreign key would have prevented and what nothing here does.
db.users.deleteMany({ account_id: 99999 });

// Scoped and safe. Expected: a small count, no warning.
db.sessions.updateMany({ ended: false, duration_ms: { $lt: 5000 } }, { $set: { ended: true } });

// Matches nothing. Expected: safe, stated plainly rather than left blank.
db.sessions.deleteMany({ 'device.kind': 'blackberry' });
