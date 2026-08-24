import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify } from '../parser/classifier';
import { editFromClassification, editsFromClassifications } from '../edit/fromSql';
import { projectSchema } from '../edit/project';
import { SchemaSnapshot } from '../adapters/types';

/**
 * A migration file, expressed as edits.
 *
 * This is what lets a hand-written file and a change made by clicking share one
 * answer to "what will this look like afterwards". Two implementations would
 * eventually disagree, and the wrong one would be whichever was used less.
 */

const editFor = (sql: string) => editFromClassification(classify(sql));

describe('editFromClassification', () => {
  it('maps the structural statements', () => {
    assert.deepEqual(editFor('ALTER TABLE users DROP COLUMN phone_number'), {
      kind: 'drop_column',
      table: 'users',
      column: 'phone_number',
    });

    assert.deepEqual(editFor('ALTER TABLE users ALTER COLUMN email SET NOT NULL'), {
      kind: 'set_nullability',
      table: 'users',
      column: 'email',
      nullable: false,
    });

    assert.deepEqual(editFor('ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint'), {
      kind: 'alter_type',
      table: 'orders',
      column: 'total_cents',
      to: 'bigint',
    });

    assert.deepEqual(editFor('DROP TABLE carts'), { kind: 'drop_table', table: 'carts' });
  });

  it('maps a foreign key with both ends', () => {
    const edit = editFor(
      'ALTER TABLE users ADD CONSTRAINT users_org_fkey FOREIGN KEY (org_id) REFERENCES orgs (id)',
    );
    assert.deepEqual(edit, {
      kind: 'add_foreign_key',
      table: 'users',
      columns: ['org_id'],
      referencedTable: 'orgs',
      referencedColumns: ['id'],
    });
  });

  it('declines rather than guessing when the target name is not extracted', () => {
    // The classifier keeps the old name for a rename but not the new one.
    // Projecting it would rename the column to nothing, which is worse than
    // leaving the picture alone.
    assert.equal(editFor('ALTER TABLE users RENAME COLUMN a TO b'), undefined);
    assert.equal(editFor('ALTER TABLE users RENAME TO people'), undefined);
  });

  it('declines for statements that do not move the picture', () => {
    // These still appear in the preview with their measured consequences —
    // they just do not change the shape the diagram draws.
    assert.equal(editFor('CREATE INDEX idx ON orders (user_id)'), undefined);
    assert.equal(editFor(`UPDATE users SET tier = 'free'`), undefined);
    assert.equal(editFor(`DELETE FROM carts`), undefined);
    assert.equal(editFor('GRANT SELECT ON users TO analyst'), undefined);
  });
});

describe('editsFromClassifications', () => {
  it('keeps file order, and reports which statements produced edits', () => {
    const sql = [
      'ALTER TABLE users DROP COLUMN phone_number',
      'CREATE INDEX idx ON orders (user_id)',
      'ALTER TABLE users ALTER COLUMN email SET NOT NULL',
    ];

    const { edits, indexes } = editsFromClassifications(sql.map(classify));

    assert.equal(edits.length, 2);
    assert.deepEqual(indexes, [0, 2], 'the index build produced no edit, and is skipped');
    assert.equal(edits[0]!.kind, 'drop_column');
    assert.equal(edits[1]!.kind, 'set_nullability');
  });

  it('projects a whole migration onto a schema', () => {
    const before: SchemaSnapshot = {
      schemas: ['public'],
      foreignKeys: [],
      tables: [
        {
          schema: 'public',
          name: 'users',
          qualified: 'users',
          rows: 100,
          bytes: 1,
          partitioned: false,
          columns: [
            { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
            { name: 'email', type: 'text', nullable: true, isPrimaryKey: false },
            { name: 'phone_number', type: 'text', nullable: true, isPrimaryKey: false },
          ],
        },
      ],
    };

    const { edits } = editsFromClassifications(
      [
        'ALTER TABLE users DROP COLUMN phone_number',
        'ALTER TABLE users ALTER COLUMN email SET NOT NULL',
      ].map(classify),
    );

    const after = projectSchema(before, edits);
    const users = after.tables[0]!;

    assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email']);
    assert.equal(users.columns.find((c) => c.name === 'email')!.nullable, false);
  });
});
