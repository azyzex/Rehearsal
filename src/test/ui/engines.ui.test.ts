import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { schemaPanelHtml } from '../../panel/html';
import { closeBrowser, count, openPanel, texts, visible } from '../support/uiHarness';

/**
 * The explorer, drawing something other than Postgres.
 *
 * The adapters all return the same shape, which is the point of the contract —
 * but "the same shape" has never actually been drawn for two of the three. A
 * MongoDB snapshot carries things a relational one never does: a field that
 * holds two types, a relationship that is an inference rather than a
 * constraint, and no schema qualifier anywhere.
 *
 * If any of that renders as `undefined` or an empty card, the abstraction is
 * leaking somewhere only a browser can see.
 */

const field = (name: string, type: string, nullable = true) => ({
  name,
  type,
  nullable,
  isPrimaryKey: name === '_id',
});

/** What MongoAdapter.schemaSnapshot really produces. */
const MONGO = {
  schemas: ['analytics'],
  tables: [
    {
      schema: 'analytics',
      name: 'events',
      qualified: 'events',
      rows: 200_000,
      bytes: 48_000_000,
      partitioned: false,
      columns: [
        field('_id', 'int', false),
        field('name', 'string', false),
        field('user_id', 'int | null'),
        // A field holding two types is ordinary here and impossible in SQL.
        field('revenue_cents', 'double | int'),
        field('created_at', 'date', false),
        field('legacy_utm', 'string'),
      ],
    },
    {
      schema: 'analytics',
      name: 'sessions',
      qualified: 'sessions',
      rows: 40_000,
      bytes: 6_000_000,
      partitioned: false,
      columns: [field('_id', 'int', false), field('device', 'string', false), field('ended', 'bool', false)],
    },
  ],
  foreignKeys: [
    {
      // Inferred by counting how many values line up, not declared anywhere.
      name: 'events.user_id → sessions._id (inferred)',
      fromTable: 'events',
      fromColumns: ['user_id'],
      toTable: 'sessions',
      toColumns: ['_id'],
    },
  ],
};

/** What MysqlAdapter.schemaSnapshot produces: types as MySQL renders them. */
const MYSQL = {
  schemas: ['blog'],
  tables: [
    {
      schema: 'blog',
      name: 'authors',
      qualified: 'authors',
      rows: 20_000,
      bytes: 4_000_000,
      partitioned: false,
      columns: [
        { name: 'id', type: 'int unsigned', nullable: false, isPrimaryKey: true, identity: 'by default' },
        { name: 'email', type: 'varchar(255)', nullable: true, isPrimaryKey: false },
        { name: 'bio', type: 'mediumtext', nullable: true, isPrimaryKey: false },
      ],
    },
    {
      schema: 'blog',
      name: 'posts',
      qualified: 'posts',
      rows: 60_000,
      bytes: 20_000_000,
      partitioned: false,
      columns: [
        { name: 'id', type: 'int unsigned', nullable: false, isPrimaryKey: true },
        { name: 'author_id', type: 'int unsigned', nullable: false, isPrimaryKey: false },
        { name: 'status', type: "enum('draft','published')", nullable: false, isPrimaryKey: false },
      ],
    },
  ],
  foreignKeys: [
    {
      name: 'posts_author_fk',
      fromTable: 'posts',
      fromColumns: ['author_id'],
      toTable: 'authors',
      toColumns: ['id'],
    },
  ],
};

describe('the explorer, drawing the other two engines', () => {
  after(async () => {
    await closeBrowser();
  });

  describe('MongoDB', () => {
    it('draws collections as cards, with their inferred shape', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MONGO, connection: 'analytics@atlas' });

        assert.deepEqual(panel.problems, []);
        assert.equal(await count(panel.page, '.table'), 2);
        assert.deepEqual([...(await texts(panel.page, '.table-title'))].sort(), [
          'events',
          'sessions',
        ]);
      } finally {
        await panel.close();
      }
    });

    it('shows a field that holds more than one type as holding both', async () => {
      // A schema explorer that picks one type for a field holding three is
      // lying quietly, and MongoDB is where that happens.
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MONGO, connection: 'analytics@atlas' });

        const types = await texts(panel.page, '.table[data-table="events"] .col-type');
        assert.ok(
          types.some((type) => type.includes('|')),
          `no mixed type survived rendering: ${types.join(', ')}`,
        );
      } finally {
        await panel.close();
      }
    });

    it('draws the inferred relationship as an edge like any other', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MONGO, connection: 'analytics@atlas' });
        assert.ok((await count(panel.page, '#edges path, #edges line')) >= 1);
        assert.match((await panel.page.textContent('#stats')) ?? '', /2 tables, 1 relationship/);
      } finally {
        await panel.close();
      }
    });

    it('opens a collection without leaving undefined anywhere', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MONGO, connection: 'analytics@atlas' });
        await panel.send({
          type: 'tableDetail',
          detail: {
            table: 'events',
            rows: 200_000,
            rowsEstimated: false,
            primaryKey: ['_id'],
            columns: MONGO.tables[0]!.columns,
            indexes: [
              {
                name: '_id_',
                columns: ['_id'],
                unique: true,
                primary: true,
                definition: 'db.events.createIndex({"_id":1})',
              },
            ],
            constraints: [],
            sample: [{ _id: '1', name: 'view', user_id: '4', 'payload.utm': 'spring' }],
            sampleRaw: [{ _id: 1, name: 'view', user_id: 4, 'payload.utm': 'spring' }],
          },
        });

        assert.equal(await visible(panel.page, '#drawer'), true);
        const text = (await panel.page.textContent('#drawer')) ?? '';
        assert.match(text, /events/);
        assert.doesNotMatch(text, /undefined/, 'a field the shape does not carry leaked through');
        assert.match(text, /payload\.utm/, 'a nested field keeps the name Mongo addresses it by');
      } finally {
        await panel.close();
      }
    });

    it('says there are no constraints rather than rendering an empty section badly', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MONGO, connection: 'analytics@atlas' });
        await panel.send({
          type: 'tableDetail',
          detail: {
            table: 'sessions',
            rows: 40_000,
            rowsEstimated: false,
            primaryKey: ['_id'],
            columns: MONGO.tables[1]!.columns,
            indexes: [],
            constraints: [],
            sample: [],
            sampleRaw: [],
          },
        });

        assert.deepEqual(panel.problems, [], 'an empty collection detail must not throw');
        assert.equal(await visible(panel.page, '#drawer'), true);
      } finally {
        await panel.close();
      }
    });
  });

  describe('MySQL', () => {
    it('draws its tables and its own type names', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MYSQL, connection: 'blog@localhost' });

        assert.deepEqual(panel.problems, []);
        assert.equal(await count(panel.page, '.table'), 2);

        const types = await texts(panel.page, '.table[data-table="posts"] .col-type');
        assert.ok(
          types.some((type) => type.length > 0),
          'types rendered at all',
        );
      } finally {
        await panel.close();
      }
    });

    it('does not fall over on an enum type full of quotes and commas', async () => {
      // `enum('draft','published')` goes through the same shortening as every
      // other type name, and it is the one most likely to break it.
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MYSQL, connection: 'blog@localhost' });
        assert.deepEqual(panel.problems, []);

        const columns = await texts(panel.page, '.table[data-table="posts"] .col-name');
        assert.deepEqual(columns, ['id', 'author_id', 'status']);
      } finally {
        await panel.close();
      }
    });

    it('marks the primary key on a MySQL card', async () => {
      const panel = await openPanel(schemaPanelHtml, { width: 1100, height: 800 });
      try {
        await panel.send({ type: 'schema', snapshot: MYSQL, connection: 'blog@localhost' });
        assert.ok((await count(panel.page, '.col-key.pk')) >= 2);
      } finally {
        await panel.close();
      }
    });
  });
});
