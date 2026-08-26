import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForeignKeyInfo, SchemaSnapshot } from '../adapters/types';
import { findJoinPath } from '../analysis/joinPath';

/**
 * Walking the foreign-key graph.
 *
 * The database already knows how its tables connect. These tests are about the
 * two things that make walking it useful rather than merely possible: that a
 * join is followed in either direction regardless of which side declared the
 * key, and that the SQL it produces is actually runnable on a path that
 * revisits a table.
 */

const fk = (
  name: string,
  fromTable: string,
  fromColumns: string[],
  toTable: string,
  toColumns: string[],
): ForeignKeyInfo => ({ name, fromTable, fromColumns, toTable, toColumns });

const table = (qualified: string) => ({
  schema: 'public',
  name: qualified,
  qualified,
  rows: 0,
  bytes: 0,
  partitioned: false,
  columns: [],
});

const snapshot: SchemaSnapshot = {
  schemas: ['public'],
  tables: ['users', 'orders', 'order_items', 'products', 'categories', 'islands'].map(table),
  foreignKeys: [
    fk('orders_user_fkey', 'orders', ['user_id'], 'users', ['id']),
    fk('items_order_fkey', 'order_items', ['order_id'], 'orders', ['id']),
    fk('items_product_fkey', 'order_items', ['product_id'], 'products', ['id']),
    fk('products_category_fkey', 'products', ['category_id'], 'categories', ['id']),
  ],
};

describe('findJoinPath', () => {
  it('follows a key in the direction it points', () => {
    const path = findJoinPath(snapshot, 'orders', 'users')!;
    assert.deepEqual(path.tables, ['orders', 'users']);
    assert.equal(path.steps.length, 1);
    assert.equal(path.steps[0]!.via, 'orders_user_fkey');
  });

  it('follows a key against the direction it points', () => {
    // A join does not care which side declared the constraint. Without this,
    // half the questions anyone actually asks would have no answer.
    const path = findJoinPath(snapshot, 'users', 'orders')!;
    assert.deepEqual(path.tables, ['users', 'orders']);
    assert.deepEqual(path.steps[0]!.fromColumns, ['id']);
    assert.deepEqual(path.steps[0]!.toColumns, ['user_id']);
  });

  it('finds a route several joins long', () => {
    const path = findJoinPath(snapshot, 'users', 'categories')!;
    assert.deepEqual(path.tables, ['users', 'orders', 'order_items', 'products', 'categories']);
    assert.equal(path.steps.length, 4);
  });

  it('takes the shortest route rather than the first one', () => {
    // A direct key is added between the two ends; the four-join route still
    // exists and must not be preferred.
    const withShortcut: SchemaSnapshot = {
      ...snapshot,
      foreignKeys: [
        ...snapshot.foreignKeys,
        fk('users_category_fkey', 'users', ['favourite_category_id'], 'categories', ['id']),
      ],
    };

    const path = findJoinPath(withShortcut, 'users', 'categories')!;
    assert.equal(path.steps.length, 1);
    assert.equal(path.steps[0]!.via, 'users_category_fkey');
  });

  it('returns nothing rather than guessing when there is no route', () => {
    assert.equal(findJoinPath(snapshot, 'users', 'islands'), undefined);
  });

  it('says "you are already there" for a table that does not reference itself', () => {
    const path = findJoinPath(snapshot, 'users', 'users')!;
    assert.deepEqual(path.steps, []);
    assert.match(path.sql, /FROM "users" AS t0/);
  });

  it('produces SQL that runs', () => {
    const path = findJoinPath(snapshot, 'users', 'products')!;
    assert.equal(
      path.sql,
      [
        'SELECT *',
        '  FROM "users" AS t0',
        '  JOIN "orders" AS t1 ON t0."id" = t1."user_id"',
        '  JOIN "order_items" AS t2 ON t1."id" = t2."order_id"',
        '  JOIN "products" AS t3 ON t2."product_id" = t3."id"',
      ].join('\n'),
    );
  });

  it('answers a self-referencing table with the self-join, aliased so it parses', () => {
    // A category hierarchy, an employee's manager. Shortest-path alone returns
    // "you are already there", which is true and useless; the self-join is what
    // the question meant. Aliasing is not optional here — an unaliased
    // self-join is ambiguous.
    const selfReferencing: SchemaSnapshot = {
      schemas: ['public'],
      tables: ['categories'].map(table),
      foreignKeys: [fk('categories_parent_fkey', 'categories', ['parent_id'], 'categories', ['id'])],
    };

    const path = findJoinPath(selfReferencing, 'categories', 'categories')!;

    assert.equal(path.steps.length, 1);
    assert.equal(path.steps[0]!.via, 'categories_parent_fkey');
    assert.equal(
      path.sql,
      [
        'SELECT *',
        '  FROM "categories" AS t0',
        '  JOIN "categories" AS t1 ON t0."parent_id" = t1."id"',
      ].join('\n'),
    );
  });

  it('joins on every column of a composite key', () => {
    const composite: SchemaSnapshot = {
      schemas: ['public'],
      tables: ['a', 'b'].map(table),
      foreignKeys: [fk('a_b_fkey', 'a', ['x', 'y'], 'b', ['p', 'q'])],
    };

    const path = findJoinPath(composite, 'a', 'b')!;
    assert.match(path.sql, /t0\."x" = t1\."p" AND t0\."y" = t1\."q"/);
  });

  it('quotes names that need it', () => {
    const awkward: SchemaSnapshot = {
      schemas: ['public', 'billing'],
      tables: ['users', 'billing.invoices'].map(table),
      foreignKeys: [fk('inv_fkey', 'billing.invoices', ['user_id'], 'users', ['id'])],
    };

    const path = findJoinPath(awkward, 'users', 'billing.invoices')!;
    assert.match(path.sql, /JOIN "billing"\."invoices" AS t1/);
  });
});

describe('the route, in each engine', () => {
  const table = (name: string) => ({
    schema: 'public',
    name,
    qualified: name,
    rows: 1,
    bytes: 1,
    partitioned: false,
    columns: [],
  });

  const snapshot = {
    schemas: ['public'],
    tables: ['orders', 'users', 'orgs'].map(table),
    foreignKeys: [
      {
        name: 'orders_user_id_fkey',
        fromTable: 'orders',
        fromColumns: ['user_id'],
        toTable: 'users',
        toColumns: ['id'],
      },
      {
        name: 'users_org_id_fkey',
        fromTable: 'users',
        fromColumns: ['org_id'],
        toTable: 'orgs',
        toColumns: ['id'],
      },
    ],
  };

  it('quotes Postgres the ANSI way', () => {
    const route = findJoinPath(snapshot, 'orders', 'users', 'postgres');
    assert.match(route!.sql, /FROM "orders" AS t0/);
    assert.doesNotMatch(route!.sql, /`/);
  });

  it('quotes MySQL with backticks, which is the only form it accepts', () => {
    // A route quoted the ANSI way is a query that will not run for the person
    // being handed it — `"orders"` is a string literal to MySQL.
    const route = findJoinPath(snapshot, 'orders', 'users', 'mysql');
    assert.match(route!.sql, /FROM `orders` AS t0/);
    assert.match(route!.sql, /t0\.`user_id` = t1\.`id`/);
    assert.doesNotMatch(route!.sql, /"orders"|"users"|"user_id"/);
  });

  it('defaults to Postgres when nothing says otherwise', () => {
    assert.match(findJoinPath(snapshot, 'orders', 'users')!.sql, /"orders"/);
  });

  it('reaches through the second hop with the right prefix, for MongoDB', () => {
    // After `$unwind: "$users"` the next lookup's local field is at
    // `users.org_id`, not `org_id`. Getting that wrong gives a pipeline that
    // runs, returns nothing, and looks correct.
    const route = findJoinPath(snapshot, 'orders', 'orgs', 'mongo');
    assert.match(route!.pipeline, /localField: "user_id"/);
    assert.match(route!.pipeline, /localField: "users\.org_id"/);
    assert.doesNotMatch(route!.pipeline, /SELECT|JOIN/i);
  });
});
