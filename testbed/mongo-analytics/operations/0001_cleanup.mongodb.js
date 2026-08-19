// Staged for v3. The Mongo equivalent of a migration file: a handful of
// write operations someone is about to run against real data.

// Destructive: removes a field from ~40,000 documents. There is no schema to
// consult afterwards to find out what was in it.
db.events.updateMany({ legacy_utm: { $exists: true } }, { $unset: { legacy_utm: '' } });

// The blast-radius case. `user_id: null` matches a third of the collection,
// and the author probably meant documents where the field is missing entirely.
db.events.deleteMany({ user_id: null });

// What they probably meant. Expected: a far smaller count.
db.events.deleteMany({ user_id: { $exists: false } });

// Scoped and safe.
db.sessions.updateMany({ ended: false, duration_ms: { $lt: 5000 } }, { $set: { ended: true } });

// Matches nothing. Expected: safe, stated plainly.
db.sessions.deleteMany({ device: 'blackberry' });
