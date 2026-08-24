import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SchemaSnapshot } from '../adapters/types';
import { toMermaid } from '../panel/mermaid';

/**
 * Exporting the diagram as Mermaid.
 *
 * Mermaid is fussy about its identifier and attribute grammar, and a diagram
 * that fails to render on GitHub is worse than no export at all — it looks like
 * a broken README rather than a missing feature. These tests are mostly about
 * what has to be scrubbed out of real Postgres names and types.
 */

const snapshot: SchemaSnapshot = {
  schemas: ['public', 'billing'],
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
        { name: 'email', type: 'character varying(255)', nullable: true, isPrimaryKey: false },
        { name: 'tags', type: 'text[]', nullable: true, isPrimaryKey: false },
      ],
    },
    {
      schema: 'billing',
      name: 'invoices',
      qualified: 'billing.invoices',
      rows: 10,
      bytes: 1,
      partitioned: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
        { name: 'user_id', type: 'integer', nullable: false, isPrimaryKey: false },
      ],
    },
  ],
  foreignKeys: [
    {
      name: 'invoices_user_fkey',
      fromTable: 'billing.invoices',
      fromColumns: ['user_id'],
      toTable: 'users',
      toColumns: ['id'],
    },
  ],
};

describe('toMermaid', () => {
  const output = toMermaid(snapshot);

  it('opens with the diagram type GitHub recognises', () => {
    assert.match(output, /^erDiagram\n/);
  });

  it('includes every table', () => {
    assert.match(output, /users \{/);
    assert.match(output, /billing_invoices \{/);
  });

  it('replaces characters Mermaid will not accept in a name', () => {
    // A dot is a schema separator to Postgres and a syntax error to Mermaid.
    assert.equal(output.includes('billing.invoices'), false);
    assert.match(output, /billing_invoices/);
  });

  it('reduces types to something the attribute grammar accepts', () => {
    // `character varying(255)` and `text[]` both break it as written.
    assert.match(output, /character_varying email/);
    assert.match(output, /text_array tags/);
    assert.equal(output.includes('(255)'), false);
    assert.equal(output.includes('[]'), false);
  });

  it('marks primary keys', () => {
    assert.match(output, /integer id PK/);
  });

  it('draws the relationship many-to-one, in the direction a foreign key means', () => {
    // Several invoices point at one user, not the other way round.
    assert.match(output, /users \|\|--o\{ billing_invoices : "user_id"/);
  });

  it('skips a relationship whose other end is not in the picture', () => {
    const partial = toMermaid({
      ...snapshot,
      tables: [snapshot.tables[0]!],
    });
    assert.equal(partial.includes('billing_invoices'), false);
    assert.equal(partial.includes('||--o{'), false);
  });

  it('can leave the columns out for a schema too big to list them', () => {
    const bare = toMermaid(snapshot, { columns: false });
    assert.match(bare, /users \{/);
    assert.equal(bare.includes('email'), false);
    assert.match(bare, /\|\|--o\{/, 'the relationships are still drawn');
  });

  it('never emits an empty type, which Mermaid rejects', () => {
    const odd = toMermaid({
      ...snapshot,
      tables: [
        {
          ...snapshot.tables[0]!,
          columns: [{ name: 'weird', type: '???', nullable: true, isPrimaryKey: false }],
        },
      ],
    });
    assert.match(odd, /unknown weird/);
  });
});
