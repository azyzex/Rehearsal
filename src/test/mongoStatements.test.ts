import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Changeset, Edit } from '../edit/changeset';
import { dialectFor } from '../edit/dialect';
import { toMongoStatement } from '../edit/mongoStatements';

/**
 * The visual editor's changes, written in MongoDB.
 *
 * Until this existed the changeset produced SQL on every engine, so a MongoDB
 * connection got `ALTER TABLE users DROP COLUMN phone` about a database with no
 * tables and no columns — in the pending list, in the exported file offered as
 * the thing to review and keep, and in the route between two collections.
 *
 * What is checked here is that the output is the operation MongoDB really has,
 * and that the four changes it does not have are refused by name rather than
 * approximated. A wrong statement is worse than a refusal here, because a
 * refusal stops and a wrong statement gets exported, reviewed and run.
 */

const sqlOf = (edit: Edit): string => toMongoStatement(edit, 0).sql;

describe('a change, written in MongoDB', () => {
  it('takes a field away with $unset, not DROP COLUMN', () => {
    assert.equal(
      sqlOf({ kind: 'drop_column', table: 'users', column: 'legacy_utm' }),
      'db.getCollection("users").updateMany({}, { $unset: { "legacy_utm": "" } })',
    );
  });

  it('reaches a nested field by the path Mongo addresses it with', () => {
    // `profile.preferences.theme` is one field with a dotted name, and quoting
    // it is not optional — unquoted it is a syntax error.
    const sql = sqlOf({ kind: 'drop_column', table: 'users', column: 'profile.avatar' });
    assert.match(sql, /\$unset: \{ "profile\.avatar": "" \}/);
  });

  it('renames with $rename', () => {
    assert.equal(
      sqlOf({ kind: 'rename_column', table: 'users', column: 'utm', to: 'campaign' }),
      'db.getCollection("users").updateMany({}, { $rename: { "utm": "campaign" } })',
    );
  });

  it('changes a type with a pipeline, and keeps what will not convert', () => {
    // `onError` returns the original value rather than writing null over it.
    // Losing the value would be a strange thing for a type change to do, and
    // the preview is what tells you how many would have been lost.
    const sql = sqlOf({ kind: 'alter_type', table: 'orders', column: 'total', to: 'double' });
    assert.match(sql, /\$convert/);
    assert.match(sql, /to: "double"/);
    assert.match(sql, /onError: "\$total"/);
  });

  it('translates the type name someone typed out of SQL habit', () => {
    // The box says "change this field to" and the words people reach for are
    // SQL's. `text` is not a BSON type; `string` is.
    assert.match(
      sqlOf({ kind: 'alter_type', table: 'users', column: 'email', to: 'text' }),
      /to: "string"/,
    );
    assert.match(
      sqlOf({ kind: 'alter_type', table: 'users', column: 'n', to: 'bigint' }),
      /to: "long"/,
    );
  });

  it('passes an unfamiliar type through rather than guessing', () => {
    // $convert knows more type names than that list does, and an error from
    // the server naming the real problem beats a guess from here.
    assert.match(
      sqlOf({ kind: 'alter_type', table: 'users', column: 'id', to: 'objectId' }),
      /to: "objectId"/,
    );
  });

  it('builds indexes with createIndex', () => {
    assert.equal(
      sqlOf({
        kind: 'add_index',
        table: 'events',
        columns: ['user_id'],
        unique: false,
        concurrently: false,
      }),
      'db.getCollection("events").createIndex({ "user_id": 1 })',
    );

    // `concurrently` has no counterpart here — MongoDB builds in the
    // background by default — so it leaves no trace rather than an option
    // that does not exist.
    assert.equal(
      sqlOf({
        kind: 'add_index',
        table: 'events',
        columns: ['user_id'],
        unique: false,
        concurrently: true,
      }),
      'db.getCollection("events").createIndex({ "user_id": 1 })',
    );

    assert.match(
      sqlOf({
        kind: 'add_index',
        table: 'users',
        columns: ['email'],
        unique: true,
        concurrently: false,
      }),
      /\{ unique: true \}/,
      'a unique index asked for as an index is still unique',
    );
    assert.equal(
      sqlOf({ kind: 'add_unique', table: 'users', columns: ['email'] }),
      'db.getCollection("users").createIndex({ "email": 1 }, { unique: true })',
    );
  });

  it('drops and renames collections, not tables', () => {
    assert.equal(sqlOf({ kind: 'drop_table', table: 'sessions' }), 'db.getCollection("sessions").drop()');
    assert.equal(
      sqlOf({ kind: 'rename_table', table: 'events', to: 'activity' }),
      'db.getCollection("events").renameCollection("activity")',
    );
  });

  it('reaches a collection by getCollection, not by property', () => {
    // A collection may be named `stats`, or `find`, or anything else that
    // collides with a method on the database object.
    assert.match(sqlOf({ kind: 'drop_table', table: 'stats' }), /getCollection\("stats"\)/);
  });

  it('edits one document by its key', () => {
    assert.equal(
      sqlOf({ kind: 'update_row', table: 'users', key: { _id: 42 }, set: { tier: 'pro' } }),
      'db.getCollection("users").updateOne({ "_id": 42 }, { $set: { "tier": "pro" } })',
    );
    assert.equal(
      sqlOf({ kind: 'delete_row', table: 'users', key: { _id: 42 } }),
      'db.getCollection("users").deleteOne({ "_id": 42 })',
    );
  });

  it('refuses to edit one document without something identifying it', () => {
    // `{}` matches the whole collection. The same reason the SQL side refuses
    // a missing WHERE, and worth more here because the filter is the only
    // thing standing between one document and all of them.
    assert.throws(
      () => sqlOf({ kind: 'delete_row', table: 'users', key: {} }),
      /needs a key/i,
    );
  });

  it('writes a date as a date, not as a string', () => {
    const sql = sqlOf({
      kind: 'update_row',
      table: 'users',
      key: { _id: 1 },
      set: { seen_at: new Date('2026-01-02T03:04:05.000Z') },
    });
    assert.match(sql, /ISODate\("2026-01-02T03:04:05\.000Z"\)/);
  });

  describe('the changes MongoDB does not have', () => {
    // Refused by name, with the reason. Approximating any of these would
    // produce something that gets exported, reviewed and run.

    it('refuses nullability, because nothing declares it here', () => {
      assert.throws(
        () => sqlOf({ kind: 'set_nullability', table: 'users', column: 'email', nullable: false }),
        /does not declare nullability/i,
      );
    });

    it('refuses a default, because the application writes it', () => {
      assert.throws(
        () => sqlOf({ kind: 'set_default', table: 'users', column: 'tier', expression: "'free'" }),
        /no column defaults/i,
      );
    });

    it('refuses a foreign key, because relationships here are a convention', () => {
      assert.throws(
        () =>
          sqlOf({
            kind: 'add_foreign_key',
            table: 'orders',
            columns: ['user_id'],
            referencedTable: 'users',
            referencedColumns: ['_id'],
          }),
        /no foreign keys/i,
      );
    });

    it('refuses a check constraint', () => {
      assert.throws(
        () => sqlOf({ kind: 'add_check', table: 'orders', expression: 'total > 0' }),
        /no check constraints/i,
      );
    });

    it('refuses a bare added field, and says what to do instead', () => {
      // There is no schema to add it to. With a value it is a backfill, which
      // is a real operation and is offered.
      assert.throws(
        () =>
          sqlOf({ kind: 'add_column', table: 'users', column: 'tier', type: 'text', nullable: true }),
        /no schema to add/i,
      );

      assert.match(
        sqlOf({
          kind: 'add_column',
          table: 'users',
          column: 'tier',
          type: 'text',
          nullable: true,
          defaultExpression: 'free',
        }),
        /\$exists: false.*\$set/s,
      );
    });
  });
});

describe('the changeset, in each engine', () => {
  const edits: Edit[] = [
    { kind: 'drop_column', table: 'users', column: 'legacy_utm' },
    { kind: 'drop_table', table: 'sessions' },
  ];

  const scriptFor = (engine: 'postgres' | 'mysql' | 'mongo'): string => {
    const changeset = new Changeset();
    changeset.useDialect(dialectFor(engine));
    for (const edit of edits) {
      changeset.add(edit);
    }
    return changeset.toSql();
  };

  it('writes SQL for the two engines that take it', () => {
    for (const engine of ['postgres', 'mysql'] as const) {
      const script = scriptFor(engine);
      assert.match(script, /ALTER TABLE/);
      assert.match(script, /DROP TABLE/);
      assert.match(script, /^-- /m, 'and comments it the SQL way');
    }
  });

  it('writes a mongosh script for the one that does not', () => {
    const script = scriptFor('mongo');

    assert.doesNotMatch(script, /ALTER TABLE|DROP TABLE|SELECT /);
    assert.match(script, /db\.getCollection\("users"\)\.updateMany/);
    assert.match(script, /db\.getCollection\("sessions"\)\.drop\(\)/);
    assert.match(script, /^\/\/ /m, 'and comments it the JavaScript way');
  });

  it('calls its buttons and its file what the engine calls them', () => {
    assert.equal(dialectFor('postgres').exportLabel, 'Export SQL');
    assert.equal(dialectFor('postgres').documentLanguage, 'sql');

    assert.equal(dialectFor('mongo').exportLabel, 'Export script');
    assert.equal(dialectFor('mongo').downLabel, 'Down script');
    assert.equal(dialectFor('mongo').documentLanguage, 'javascript');
    assert.equal(dialectFor('mongo').noun, 'operation');
  });

  it('knows which changes each engine can express at all', () => {
    assert.equal(dialectFor('mongo').hasNullability, false);
    assert.equal(dialectFor('mongo').hasForeignKeys, false);
    assert.equal(dialectFor('mongo').hasDefaults, false);

    for (const engine of ['postgres', 'mysql'] as const) {
      assert.equal(dialectFor(engine).hasNullability, true);
      assert.equal(dialectFor(engine).hasForeignKeys, true);
    }
  });

  it('defaults to SQL when nothing has said otherwise', () => {
    // A changeset that has not heard from the extension yet has nothing better
    // to guess, and two of the three engines take SQL.
    const changeset = new Changeset();
    changeset.add(edits[0]!);
    assert.match(changeset.toSql(), /ALTER TABLE/);
  });
});

describe('the SQL each SQL engine actually accepts', () => {
  // Postgres and MySQL are both "SQL" and do not agree on quoting. MySQL's
  // default sql_mode reads a double-quoted word as a string literal, so every
  // migration this exported for a MySQL user was a syntax error — offered as
  // the file to review and keep, and rejected the moment anyone ran it.
  const edits: Edit[] = [
    { kind: 'drop_column', table: 'users', column: 'email' },
    { kind: 'rename_table', table: 'users', to: 'people' },
    { kind: 'update_row', table: 'users', key: { id: 1 }, set: { tier: 'pro' } },
  ];

  const scriptFor = (engine: 'postgres' | 'mysql'): string => {
    const changeset = new Changeset();
    changeset.useDialect(dialectFor(engine));
    for (const edit of edits) {
      changeset.add(edit);
    }
    return changeset.toSql();
  };

  it('quotes Postgres the ANSI way', () => {
    const script = scriptFor('postgres');
    assert.match(script, /ALTER TABLE "users" DROP COLUMN "email"/);
    assert.doesNotMatch(script, /`/, 'no backticks anywhere');
  });

  it('quotes MySQL with backticks, everywhere it quotes at all', () => {
    const script = scriptFor('mysql');

    assert.match(script, /ALTER TABLE `users` DROP COLUMN `email`/);
    assert.match(script, /ALTER TABLE `users` RENAME TO `people`/);
    assert.match(script, /UPDATE `users` SET `tier` = 'pro' WHERE `id` = 1/);

    // The whole point: not one ANSI-quoted identifier survives, because each
    // one of them is a string literal to MySQL.
    assert.doesNotMatch(script, /"users"|"email"|"tier"|"id"|"people"/);
  });

  it('escapes a backtick in a name by doubling it', () => {
    const changeset = new Changeset();
    changeset.useDialect(dialectFor('mysql'));
    changeset.add({ kind: 'drop_table', table: 'we`ird' });
    assert.match(changeset.toSql(), /DROP TABLE `we``ird`/);
  });
});
