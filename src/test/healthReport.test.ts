import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SchemaHealth } from "../adapters/types";
import { describeAge, healthReport } from "../analysis/healthReport";

/**
 * The wording of the report.
 *
 * These read like tests of prose, and they are — but the prose is the product
 * here. A report that says "this index has never been scanned" about statistics
 * ninety minutes old has not made a mistake in arithmetic, it has told someone
 * to drop an index they need.
 */

const NOW = new Date("2026-08-24T12:00:00Z");

function health(overrides: Partial<SchemaHealth> = {}): SchemaHealth {
  return {
    statsSince: new Date("2026-05-24T12:00:00Z"),
    unusedIndexes: [],
    redundantIndexes: [],
    unindexedForeignKeys: [],
    tables: [],
    ...overrides,
  };
}

describe("the health report", () => {
  it("says nothing was found when nothing was", () => {
    const report = healthReport(health(), { connection: "db", now: NOW });
    assert.match(report, /Nothing found/);
  });

  it("leads with the window the statistics cover", () => {
    const report = healthReport(health(), {
      connection: "shop@neon",
      now: NOW,
    });
    assert.match(
      report,
      /\*\*Statistics cover:\*\* 2026-05-24T12:00:00\.000Z — 92 days/,
    );
  });

  it("refuses to call an index unused on a fresh statistics window", () => {
    // A platform that suspends idle computes resets these every time it wakes,
    // so this is the ordinary case rather than the edge case.
    const report = healthReport(
      health({
        statsSince: new Date("2026-08-24T10:30:00Z"),
        unusedIndexes: [
          {
            table: "orders",
            index: "orders_status",
            scans: 0,
            bytes: 4096,
            definition: "CREATE INDEX orders_status ON orders (status)",
          },
        ],
      }),
      { connection: "db", now: NOW },
    );

    assert.match(report, /only 90 minutes old/);
    assert.match(report, /candidates to watch, not a list to drop/);
  });

  it("is willing to say it plainly once the window is long enough", () => {
    const report = healthReport(
      health({
        unusedIndexes: [
          {
            table: "orders",
            index: "orders_status",
            scans: 0,
            bytes: 4096,
            definition: "CREATE INDEX x",
          },
        ],
      }),
      { connection: "db", now: NOW },
    );
    assert.match(report, /accumulating for 92 days/);
    assert.doesNotMatch(report, /not long enough/);
  });

  it("says so when the window is unknown rather than assuming the best", () => {
    const report = healthReport(health({ statsSince: null }), {
      connection: "db",
      now: NOW,
    });
    assert.match(report, /could not be determined/);
    assert.match(report, /unproven/);
  });

  describe("foreign keys", () => {
    const key = {
      constraint: "orders_user_fkey",
      table: "orders",
      columns: ["user_id"],
      referencedTable: "users",
      rows: 300_000,
    };

    it("gives the statement that fixes it, concurrently", () => {
      const report = healthReport(health({ unindexedForeignKeys: [key] }), {
        connection: "db",
        now: NOW,
      });
      assert.match(report, /CREATE INDEX CONCURRENTLY ON orders \(user_id\);/);
    });

    it("leaves small tables out and says how many it left out", () => {
      const report = healthReport(
        health({
          unindexedForeignKeys: [key, { ...key, table: "flags", rows: 12 }],
        }),
        { connection: "db", now: NOW },
      );
      assert.match(report, /1 more is on tables under 1,000 rows/);
      assert.doesNotMatch(report, /`flags`/);
    });

    it("writes no section at all when every one is on a small table", () => {
      const report = healthReport(
        health({ unindexedForeignKeys: [{ ...key, rows: 4 }] }),
        {
          connection: "db",
          now: NOW,
        },
      );
      assert.doesNotMatch(report, /Foreign keys with no index/);
    });
  });

  describe("redundant indexes", () => {
    it("totals what dropping them returns", () => {
      const report = healthReport(
        health({
          redundantIndexes: [
            {
              table: "orders",
              index: "orders_state",
              coveredBy: "orders_state_created",
              bytes: 6_000_000,
            },
            {
              table: "users",
              index: "users_tier",
              coveredBy: "users_tier_id",
              bytes: 2_500_000,
            },
          ],
        }),
        { connection: "db", now: NOW },
      );
      assert.match(report, /would return 8\.1 MB/);
      assert.match(report, /DROP INDEX CONCURRENTLY orders_state;/);
    });
  });

  describe("tables the planner may be guessing about", () => {
    const table = {
      table: "orders",
      liveRows: 300_000,
      deadRows: 0,
      modifiedSinceAnalyze: 0,
      lastVacuum: new Date("2026-08-01T00:00:00Z"),
      lastAnalyze: new Date("2026-08-01T00:00:00Z"),
      bytes: 1_000_000,
    };

    it("flags a table that has changed a lot since it was analysed", () => {
      const report = healthReport(
        health({ tables: [{ ...table, modifiedSinceAnalyze: 90_000 }] }),
        { connection: "db", now: NOW },
      );
      assert.match(report, /Changed since last ANALYZE/);
      assert.match(report, /90,000/);
    });

    it("leaves a table alone when the change is a rounding error", () => {
      const report = healthReport(
        health({ tables: [{ ...table, modifiedSinceAnalyze: 20 }] }),
        {
          connection: "db",
          now: NOW,
        },
      );
      assert.doesNotMatch(report, /planner may be guessing/);
    });

    it("flags dead rows vacuum has not reclaimed", () => {
      const report = healthReport(
        health({ tables: [{ ...table, deadRows: 120_000 }] }),
        {
          connection: "db",
          now: NOW,
        },
      );
      assert.match(report, /Dead rows/);
      assert.match(report, /120,000/);
    });

    it("says never rather than leaving the cell empty", () => {
      const report = healthReport(
        health({
          tables: [{ ...table, deadRows: 200_000, lastVacuum: null }],
        }),
        { connection: "db", now: NOW },
      );
      assert.match(report, /\| never \|/);
    });
  });

  describe("ages", () => {
    it("reads the way a person would say it", () => {
      const at = (iso: string) => describeAge(new Date(iso), NOW);
      assert.equal(at("2026-08-24T11:59:30Z"), "30 seconds");
      assert.equal(at("2026-08-24T11:00:00Z"), "60 minutes");
      assert.equal(at("2026-08-23T12:00:00Z"), "24 hours");
      assert.equal(at("2026-08-01T12:00:00Z"), "23 days");
    });

    it("never reports a negative age from a clock that disagrees", () => {
      assert.equal(
        describeAge(new Date("2026-08-25T12:00:00Z"), NOW),
        "0 seconds",
      );
    });

    it("says one second rather than 1 seconds", () => {
      // The window is often exactly this short: a platform that suspends idle
      // computes resets the statistics every time it wakes one up.
      assert.equal(
        describeAge(new Date("2026-08-24T11:59:59Z"), NOW),
        "1 second",
      );
      assert.equal(
        describeAge(new Date("2026-08-24T11:00:00Z"), NOW),
        "60 minutes",
      );
    });
  });
});

describe('the fix it suggests, per engine', () => {
  // `CREATE INDEX CONCURRENTLY` was recommended to everybody: a syntax error on
  // MySQL, and meaningless on a database that has no CREATE INDEX at all. A
  // reader who tries it and watches it fail stops believing the rest of the
  // report, which is the expensive part.
  const health: SchemaHealth = {
    unindexedForeignKeys: [
      {
        constraint: 'orders_user_id_fkey',
        table: 'orders',
        columns: ['user_id'],
        referencedTable: 'users',
        rows: 300_000,
      },
    ],
    unusedIndexes: [],
    redundantIndexes: [],
    tables: [],
    statsSince: new Date('2026-01-01T00:00:00.000Z'),
  };

  const fixFor = (engine: 'postgres' | 'mysql' | 'mongo'): string =>
    healthReport(health, {
      connection: 'shop',
      engine,
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

  it('offers CONCURRENTLY only to the engine that has it', () => {
    assert.match(fixFor('postgres'), /CREATE INDEX CONCURRENTLY ON orders \(user_id\)/);
    assert.doesNotMatch(fixFor('mysql'), /CONCURRENTLY/);
    assert.doesNotMatch(fixFor('mongo'), /CONCURRENTLY/);
  });

  it('offers MySQL the online build, spelled the way MySQL spells it', () => {
    const report = fixFor('mysql');
    assert.match(report, /ALTER TABLE `orders` ADD INDEX \(`user_id`\)/);
    assert.match(report, /ALGORITHM=INPLACE, LOCK=NONE/);
  });

  it('offers MongoDB a createIndex, not any SQL at all', () => {
    const report = fixFor('mongo');
    assert.match(report, /db\.getCollection\("orders"\)\.createIndex\(\{ "user_id": 1 \}\)/);
    assert.doesNotMatch(report, /CREATE INDEX|ALTER TABLE/);
  });

  it('still says Postgres when nothing said otherwise', () => {
    // An older caller that does not pass an engine should not silently change
    // behaviour.
    assert.match(
      healthReport(health, { connection: 'shop', now: new Date('2026-08-01T00:00:00.000Z') }),
      /CREATE INDEX CONCURRENTLY/,
    );
  });
});
