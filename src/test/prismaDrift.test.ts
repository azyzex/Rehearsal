import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SchemaSnapshot } from '../adapters/types';
import { compareWithPrisma, driftReport, parsePrisma } from '../analysis/prismaDrift';

const SCHEMA = `
// A comment with model Fake { in it, which must not become a model.
enum Role {
  ADMIN
  MEMBER
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  nickname  String?
  role      Role     @default(MEMBER)
  createdAt DateTime @default(now()) @map("created_at")
  legacy    String?  @ignore
  posts     Post[]
  org       Org?     @relation(fields: [orgId], references: [id])
  orgId     Int?     @map("org_id")

  @@map("users")
}

model Post {
  id     Int    @id
  title  String
  author User   @relation(fields: [userId], references: [id])
  userId Int
}

model Scratch {
  id Int @id
  @@ignore
}
`;

describe('reading a Prisma schema', () => {
  const models = parsePrisma(SCHEMA);

  it('finds the models, honours @@map and skips @@ignore', () => {
    assert.deepEqual(
      models.map((model) => [model.name, model.table]),
      [
        ['User', 'users'],
        ['Post', 'Post'],
      ],
    );
  });

  it('keeps columns, drops relations and @ignore, and honours @map', () => {
    const user = models[0]!;
    assert.deepEqual(
      user.fields.map((field) => `${field.column}${field.optional ? '?' : ''}`),
      ['id', 'email', 'nickname?', 'role', 'created_at', 'org_id?'],
    );
  });
});

describe('comparing it with the database', () => {
  const snapshot: SchemaSnapshot = {
    schemas: ['public'],
    foreignKeys: [],
    tables: [
      {
        schema: 'public',
        name: 'users',
        qualified: 'users',
        rows: 10,
        bytes: 0,
        partitioned: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
          { name: 'email', type: 'text', nullable: true, isPrimaryKey: false },
          { name: 'nickname', type: 'text', nullable: true, isPrimaryKey: false },
          { name: 'role', type: 'text', nullable: false, isPrimaryKey: false },
          { name: 'created_at', type: 'timestamptz', nullable: false, isPrimaryKey: false },
          { name: 'phone', type: 'text', nullable: true, isPrimaryKey: false },
        ],
      },
    ],
  };

  const drift = compareWithPrisma(parsePrisma(SCHEMA), snapshot);

  it('finds the model with no table, and the field with no column', () => {
    assert.deepEqual(drift.missingTables, ['Post']);
    assert.deepEqual(drift.missingColumns, ['users.org_id']);
  });

  it('finds a required field the database lets be null', () => {
    assert.deepEqual(drift.nullability, [
      { column: 'users.email', schema: 'required', database: 'nullable' },
    ]);
  });

  it('notices the column the schema does not mention', () => {
    assert.deepEqual(drift.extraColumns, ['users.phone']);
  });

  it('writes it up, and says what it did not compare', () => {
    const report = driftReport(drift, { schemaFile: 'prisma/schema.prisma', connection: 'shop' });
    assert.match(report, /## Models with no table/);
    assert.match(report, /\| `users\.email` \| required \| nullable \|/);
    assert.match(report, /Types are not compared/);
  });
});
