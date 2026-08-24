import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SchemaSnapshot } from '../adapters/types';
import { Edit } from '../edit/changeset';
import { diffSchemas, projectSchema } from '../edit/project';

/**
 * The "after" half of the before/after view.
 *
 * A projection, not a promise: it says what the edits are asking for. Whether
 * they succeed is what the preview answers by really executing them. Keeping
 * that distinction straight is the point of these tests — a `SET NOT NULL`
 * projects perfectly and still fails against twelve null rows.
 */

const schema = (): SchemaSnapshot => ({
  schemas: ['public'],
  tables: [
    {
      schema: 'public',
      name: 'users',
      qualified: 'users',
      rows: 50_000,
      bytes: 1024,
      partitioned: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'email', type: 'text', nullable: true, isPrimaryKey: false },
        { name: 'phone_number', type: 'text', nullable: true, isPrimaryKey: false },
        { name: 'org_id', type: 'integer', nullable: true, isPrimaryKey: false },
      ],
    },
    {
      schema: 'public',
      name: 'orgs',
      qualified: 'orgs',
      rows: 8,
      bytes: 64,
      partitioned: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'name', type: 'text', nullable: false, isPrimaryKey: false },
      ],
    },
  ],
  foreignKeys: [
    {
      name: 'orgs_owner_fkey',
      fromTable: 'orgs',
      fromColumns: ['id'],
      toTable: 'users',
      toColumns: ['id'],
    },
  ],
});

const project = (edits: Edit[]): SchemaSnapshot => projectSchema(schema(), edits);
const columns = (snapshot: SchemaSnapshot, table: string): string[] =>
  snapshot.tables.find((t) => t.qualified === table)!.columns.map((c) => c.name);

describe('projectSchema', () => {
  it('adds and removes columns', () => {
    const after = project([
      { kind: 'add_column', table: 'users', column: 'last_seen_at', type: 'timestamptz', nullable: true },
      { kind: 'drop_column', table: 'users', column: 'phone_number' },
    ]);

    assert.deepEqual(columns(after, 'users'), ['id', 'email', 'org_id', 'last_seen_at']);
  });

  it('leaves the original snapshot untouched', () => {
    const before = schema();
    projectSchema(before, [{ kind: 'drop_column', table: 'users', column: 'email' }]);
    assert.equal(before.tables[0]!.columns.length, 4, 'the input is not mutated');
  });

  it('renames a column, and carries the rename into relationships', () => {
    const after = project([{ kind: 'rename_column', table: 'users', column: 'id', to: 'user_id' }]);

    assert.ok(columns(after, 'users').includes('user_id'));
    assert.deepEqual(after.foreignKeys[0]!.toColumns, ['user_id']);
  });

  it('drops relationships whose column disappears', () => {
    // Dropping users.id would leave orgs pointing at a column that no longer
    // exists, so the relationship cannot survive the edit either.
    const after = project([{ kind: 'drop_column', table: 'users', column: 'id' }]);
    assert.deepEqual(after.foreignKeys, []);
  });

  it('adds a relationship, which is what the after-diagram draws', () => {
    const after = project([
      {
        kind: 'add_foreign_key',
        table: 'users',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
      },
    ]);

    const added = after.foreignKeys.find((fk) => fk.fromTable === 'users')!;
    assert.equal(added.toTable, 'orgs');
    assert.deepEqual(added.fromColumns, ['org_id']);
  });

  it('renames a table everywhere it is referenced', () => {
    const after = project([{ kind: 'rename_table', table: 'users', to: 'people' }]);

    assert.ok(after.tables.some((t) => t.qualified === 'people'));
    assert.equal(after.tables.some((t) => t.qualified === 'users'), false);
    assert.equal(after.foreignKeys[0]!.toTable, 'people');
  });

  it('drops a table and every relationship touching it', () => {
    const after = project([{ kind: 'drop_table', table: 'users' }]);
    assert.deepEqual(after.tables.map((t) => t.qualified), ['orgs']);
    assert.deepEqual(after.foreignKeys, []);
  });

  it('changes a type and a nullability', () => {
    const after = project([
      { kind: 'alter_type', table: 'users', column: 'org_id', to: 'bigint' },
      { kind: 'set_nullability', table: 'users', column: 'email', nullable: false },
    ]);

    const users = after.tables.find((t) => t.qualified === 'users')!;
    assert.equal(users.columns.find((c) => c.name === 'org_id')!.type, 'bigint');
    assert.equal(users.columns.find((c) => c.name === 'email')!.nullable, false);
  });

  it('leaves the picture alone for row edits', () => {
    // Rows change; structure does not. The diagram should not flicker because
    // someone edited a value.
    const after = project([
      { kind: 'update_row', table: 'users', key: { id: 1 }, set: { email: 'x@example.com' } },
      { kind: 'delete_row', table: 'users', key: { id: 2 } },
    ]);
    assert.deepEqual(columns(after, 'users'), ['id', 'email', 'phone_number', 'org_id']);
  });

  it('applies edits in order', () => {
    const after = project([
      { kind: 'add_column', table: 'users', column: 'temp', type: 'text', nullable: true },
      { kind: 'rename_column', table: 'users', column: 'temp', to: 'permanent' },
    ]);
    assert.ok(columns(after, 'users').includes('permanent'));
    assert.equal(columns(after, 'users').includes('temp'), false);
  });

  it('adds a new table to the picture', () => {
    const after = project([
      {
        kind: 'create_table',
        table: 'invoices',
        columns: [
          { name: 'id', type: 'bigserial', nullable: false, primaryKey: true },
          { name: 'total', type: 'integer', nullable: false },
        ],
      },
    ]);

    const created = after.tables.find((t) => t.qualified === 'invoices')!;
    assert.ok(created, 'the after-diagram has somewhere to draw it');
    assert.deepEqual(created.columns.map((c) => c.name), ['id', 'total']);
    assert.equal(created.columns[0]!.isPrimaryKey, true);
    assert.equal(created.rows, 0);
  });

  it('lets a new table be edited before it exists', () => {
    // The order the visual editor produces: create it, then add to it. Both
    // are pending, so the second has to see the first.
    const after = project([
      {
        kind: 'create_table',
        table: 'invoices',
        columns: [{ name: 'id', type: 'bigserial', nullable: false, primaryKey: true }],
      },
      { kind: 'add_column', table: 'invoices', column: 'note', type: 'text', nullable: true },
    ]);

    assert.deepEqual(
      after.tables.find((t) => t.qualified === 'invoices')!.columns.map((c) => c.name),
      ['id', 'note'],
    );
  });

  it('does not duplicate a table that already exists', () => {
    // The preview reports the real conflict; the picture should not show two.
    const after = project([
      {
        kind: 'create_table',
        table: 'users',
        columns: [{ name: 'id', type: 'integer', nullable: false }],
      },
    ]);
    assert.equal(after.tables.filter((t) => t.qualified === 'users').length, 1);
  });

  it('ignores an edit against a table that is not there', () => {
    const after = project([{ kind: 'drop_column', table: 'nope', column: 'x' }]);
    assert.equal(after.tables.length, 2);
  });
});

describe('diffSchemas', () => {
  const diffFor = (edits: Edit[]) => {
    const before = schema();
    return diffSchemas(before, projectSchema(before, edits), edits);
  };

  it('summarises added and removed columns', () => {
    const diff = diffFor([
      { kind: 'drop_column', table: 'users', column: 'phone_number' },
      { kind: 'add_column', table: 'users', column: 'phone', type: 'text', nullable: true },
    ]);

    const removed = diff.columns.find((c) => c.change === 'removed')!;
    assert.equal(removed.column, 'phone_number');
    assert.match(removed.note, /is dropped/);

    const added = diff.columns.find((c) => c.change === 'added')!;
    assert.equal(added.column, 'phone');
    assert.match(added.note, /added as text/);
  });

  it('reports a type change with both sides', () => {
    const diff = diffFor([{ kind: 'alter_type', table: 'users', column: 'org_id', to: 'bigint' }]);
    const change = diff.columns.find((c) => c.change === 'retyped')!;
    assert.equal(change.before!.type, 'integer');
    assert.equal(change.after!.type, 'bigint');
    assert.match(change.note, /from integer to bigint/);
  });

  it('reports a nullability change in the direction it happens', () => {
    assert.match(
      diffFor([{ kind: 'set_nullability', table: 'users', column: 'email', nullable: false }])
        .columns[0]!.note,
      /stops allowing nulls/,
    );
    assert.match(
      diffFor([{ kind: 'set_nullability', table: 'orgs', column: 'name', nullable: true }])
        .columns[0]!.note,
      /starts allowing nulls/,
    );
  });

  it('states what a dropped table costs', () => {
    const diff = diffFor([{ kind: 'drop_table', table: 'users' }]);
    const removed = diff.tables.find((t) => t.change === 'removed')!;
    assert.match(removed.note, /dropped, with all 50,000 rows/);
  });

  it('reports relationships gained and lost', () => {
    const added = diffFor([
      {
        kind: 'add_foreign_key',
        table: 'users',
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
      },
    ]);
    assert.equal(added.relationships[0]!.change, 'added');
    assert.match(added.relationships[0]!.note, /users\.org_id now points at orgs/);

    const lost = diffFor([{ kind: 'drop_column', table: 'orgs', column: 'id' }]);
    assert.ok(lost.relationships.some((r) => r.change === 'removed'));
  });

  it('counts row edits separately from structural ones', () => {
    const diff = diffFor([
      { kind: 'update_row', table: 'users', key: { id: 1 }, set: { email: 'a@b.c' } },
      { kind: 'delete_row', table: 'users', key: { id: 2 } },
      { kind: 'drop_column', table: 'users', column: 'email' },
    ]);

    assert.equal(diff.dataEdits, 2);
    assert.equal(diff.columns.length, 1, 'only the structural edit shows in the schema diff');
  });

  it('is empty when nothing changed', () => {
    const diff = diffFor([]);
    assert.deepEqual(diff.tables, []);
    assert.deepEqual(diff.columns, []);
    assert.deepEqual(diff.relationships, []);
    assert.equal(diff.dataEdits, 0);
  });
});
