import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Changeset,
  Edit,
  describeEdit,
  inlineParams,
  quoteIdentifier,
  toStatement,
} from '../edit/changeset';

/**
 * The visual editor's SQL generation.
 *
 * These tests carry more weight than their size suggests. Clicking "drop
 * column" is a far easier action than typing the statement, so the generated
 * SQL is the last place a mistake stays cheap — and it is the one place in the
 * codebase where identifiers supplied from a UI reach a statement directly.
 */

const sqlFor = (edit: Edit): string => toStatement(edit, 0).sql;

describe('generated DDL', () => {
  it('adds a column, with nullability and default', () => {
    assert.equal(
      sqlFor({ kind: 'add_column', table: 'users', column: 'last_seen_at', type: 'timestamptz', nullable: true }),
      'ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamptz',
    );

    assert.equal(
      sqlFor({
        kind: 'add_column',
        table: 'users',
        column: 'tier',
        type: 'text',
        nullable: false,
        defaultExpression: "'free'",
      }),
      `ALTER TABLE "users" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL`,
    );
  });

  it('handles the rest of the column edits', () => {
    assert.equal(
      sqlFor({ kind: 'drop_column', table: 'users', column: 'phone_number' }),
      'ALTER TABLE "users" DROP COLUMN "phone_number"',
    );
    assert.equal(
      sqlFor({ kind: 'rename_column', table: 'users', column: 'a', to: 'b' }),
      'ALTER TABLE "users" RENAME COLUMN "a" TO "b"',
    );
    assert.equal(
      sqlFor({ kind: 'alter_type', table: 'orders', column: 'total_cents', to: 'bigint' }),
      'ALTER TABLE "orders" ALTER COLUMN "total_cents" TYPE bigint',
    );
    assert.equal(
      sqlFor({ kind: 'set_nullability', table: 'users', column: 'email', nullable: false }),
      'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL',
    );
    assert.equal(
      sqlFor({ kind: 'set_nullability', table: 'users', column: 'email', nullable: true }),
      'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL',
    );
  });

  it('builds constraints and indexes with sensible default names', () => {
    assert.equal(
      sqlFor({ kind: 'add_index', table: 'orders', columns: ['user_id'], unique: false, concurrently: true }),
      'CREATE INDEX CONCURRENTLY "idx_orders_user_id" ON "orders" ("user_id")',
    );
    assert.equal(
      sqlFor({ kind: 'add_unique', table: 'users', columns: ['email'] }),
      'ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email")',
    );
    assert.equal(
      sqlFor({
        kind: 'add_foreign_key',
        table: 'users',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
      }),
      'ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id")',
    );
  });

  it('qualifies schema-qualified tables correctly', () => {
    assert.equal(
      sqlFor({ kind: 'drop_column', table: 'billing.invoices', column: 'note' }),
      'ALTER TABLE "billing"."invoices" DROP COLUMN "note"',
    );
  });
});

describe('generated DML', () => {
  it('binds values rather than interpolating them', () => {
    const statement = toStatement(
      { kind: 'update_row', table: 'users', key: { id: 7 }, set: { tier: 'pro', email: null } },
      0,
    );

    assert.equal(
      statement.sql,
      'UPDATE "users" SET "tier" = $1, "email" = $2 WHERE "id" = $3',
    );
    assert.deepEqual(statement.params, ['pro', null, 7]);
  });

  it('matches a composite key on every part', () => {
    const statement = toStatement(
      { kind: 'delete_row', table: 'order_coupons', key: { order_id: 3, coupon_id: 9 } },
      0,
    );
    assert.equal(
      statement.sql,
      'DELETE FROM "order_coupons" WHERE "order_id" = $1 AND "coupon_id" = $2',
    );
    assert.deepEqual(statement.params, [3, 9]);
  });

  it('compares a null key part with IS NULL, not equality', () => {
    // `x = NULL` is never true, so an equality test would silently match no
    // rows and the edit would appear to do nothing.
    const statement = toStatement(
      { kind: 'delete_row', table: 't', key: { a: 1, b: null } },
      0,
    );
    assert.equal(statement.sql, 'DELETE FROM "t" WHERE "a" = $1 AND "b" IS NULL');
    assert.deepEqual(statement.params, [1]);
  });

  it('refuses a row edit that cannot be limited to one row', () => {
    // An empty key would produce WHERE true and rewrite the whole table.
    assert.throws(
      () => toStatement({ kind: 'delete_row', table: 'users', key: {} }, 0),
      /no primary key/,
    );
    assert.throws(
      () => toStatement({ kind: 'update_row', table: 'users', key: {}, set: { a: 1 } }, 0),
      /no primary key/,
    );
  });

  it('refuses an update with nothing to set', () => {
    assert.throws(
      () => toStatement({ kind: 'update_row', table: 'users', key: { id: 1 }, set: {} }, 0),
      /at least one column/,
    );
  });

  it('inserts with bound values', () => {
    const statement = toStatement(
      { kind: 'insert_row', table: 'orgs', values: { name: 'acme', plan: 'enterprise' } },
      0,
    );
    assert.equal(statement.sql, 'INSERT INTO "orgs" ("name", "plan") VALUES ($1, $2)');
    assert.deepEqual(statement.params, ['acme', 'enterprise']);
  });
});

describe('identifiers and expressions', () => {
  it('escapes a quote inside an identifier rather than letting it end the quoting', () => {
    assert.equal(quoteIdentifier('we"ird'), '"we""ird"');
  });

  it('quotes an identifier that would otherwise inject', () => {
    // Identifiers cannot be bound, so this is the one place caller text reaches
    // the SQL. Quoting must neutralise it rather than the value escaping.
    const sql = sqlFor({ kind: 'drop_column', table: 'users', column: 'a"; DROP TABLE users; --' });
    assert.equal(sql, 'ALTER TABLE "users" DROP COLUMN "a""; DROP TABLE users; --"');
  });

  it('refuses an identifier it cannot quote safely', () => {
    assert.throws(() => quoteIdentifier('a\0b'), /Invalid identifier/);
    assert.throws(() => quoteIdentifier('   '), /cannot be empty/);
  });

  it('refuses a type name that is not a type name', () => {
    assert.throws(
      () => sqlFor({ kind: 'alter_type', table: 't', column: 'c', to: 'text; DROP TABLE users' }),
      /Unsupported type/,
    );
  });

  it('accepts the type shapes that are real', () => {
    assert.match(sqlFor({ kind: 'alter_type', table: 't', column: 'c', to: 'varchar(20)' }), /varchar\(20\)/);
    assert.match(sqlFor({ kind: 'alter_type', table: 't', column: 'c', to: 'numeric(10, 2)' }), /numeric\(10, 2\)/);
    assert.match(sqlFor({ kind: 'alter_type', table: 't', column: 'c', to: 'text[]' }), /text\[\]/);
    assert.match(
      sqlFor({ kind: 'alter_type', table: 't', column: 'c', to: 'timestamp with time zone' }),
      /timestamp with time zone/,
    );
  });

  it('refuses an expression carrying a statement terminator or a comment', () => {
    assert.throws(
      () => sqlFor({ kind: 'add_check', table: 't', expression: 'a > 0; DROP TABLE users' }),
      /statement terminators/,
    );
    assert.throws(
      () => sqlFor({ kind: 'add_check', table: 't', expression: 'a > 0 -- ' }),
      /statement terminators/,
    );
  });
});

describe('Changeset', () => {
  it('keeps edits in order, because order changes meaning', () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_column', table: 'users', column: 'phone_number' });
    changeset.add({ kind: 'add_column', table: 'users', column: 'phone', type: 'text', nullable: true });

    assert.deepEqual(
      changeset.statements().map((s) => s.sql),
      [
        'ALTER TABLE "users" DROP COLUMN "phone_number"',
        'ALTER TABLE "users" ADD COLUMN "phone" text',
      ],
    );
  });

  it('adds, removes and clears', () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'drop_table', table: 'a' });
    const second = changeset.add({ kind: 'drop_table', table: 'b' });
    assert.equal(changeset.size, 2);

    changeset.removeAt(second);
    assert.equal(changeset.size, 1);
    assert.equal(changeset.list()[0]!.table, 'a');

    changeset.clear();
    assert.equal(changeset.isEmpty, true);
  });

  it('exports a migration file a human could review and keep', () => {
    const changeset = new Changeset();
    changeset.add({ kind: 'update_row', table: 'users', key: { id: 7 }, set: { tier: 'pro' } });

    const sql = changeset.toSql();
    assert.match(sql, /-- Update one row in users \(id = 7\)/);
    assert.match(sql, /UPDATE "users" SET "tier" = 'pro' WHERE "id" = 7;/);
  });

  it('escapes quotes when inlining values for display', () => {
    assert.equal(
      inlineParams('UPDATE t SET a = $1', ["it's"]),
      `UPDATE t SET a = 'it''s'`,
    );
    assert.equal(inlineParams('UPDATE t SET a = $1', [null]), 'UPDATE t SET a = NULL');
  });
});

describe('describeEdit', () => {
  it('says what each edit does in plain English', () => {
    assert.equal(
      describeEdit({ kind: 'drop_column', table: 'users', column: 'phone_number' }),
      'Drop users.phone_number',
    );
    assert.equal(
      describeEdit({ kind: 'delete_row', table: 'users', key: { id: 12 } }),
      'Delete one row from users (id = 12)',
    );
    assert.equal(
      describeEdit({
        kind: 'add_foreign_key',
        table: 'users',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
      }),
      'Link users (org_id) to orgs',
    );
  });
});
