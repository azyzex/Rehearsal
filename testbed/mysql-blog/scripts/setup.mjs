#!/usr/bin/env node
/**
 * Seeds the MySQL testbed.
 *
 *   node testbed/mysql-blog/scripts/setup.mjs --url "mysql://user:pass@host:3306/blog"
 *
 * Shapes the data to mirror postgres-shop: null emails, duplicate emails,
 * orphaned foreign keys, a column that is null in every row, and a comments
 * table large enough for an index build to cost something.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');

// Overridable, because 400,000 comments is a slow seed and the findings keep
// their shape at a tenth of the size — only the numbers shrink.
const AUTHORS = Number(argOf('--authors', 20_000));
const POSTS = Number(argOf('--posts', 60_000));
const COMMENTS = Number(argOf('--comments', 400_000));

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadDriver() {
  try {
    return (await import('mysql2/promise')).default;
  } catch {
    throw new Error(
      'mysql2 is not installed:\n  npm install --save-dev mysql2',
    );
  }
}

async function main() {
  const url = arg('--url') ?? process.env.MYSQL_URL;
  if (!url) {
    throw new Error('Pass --url "mysql://user:pass@host:3306/blog" or set MYSQL_URL.');
  }
  if (/prod|production|live/i.test(url.replace(/\/\/[^@]*@/, '//'))) {
    throw new Error('Refusing to seed: this connection looks like production, and this script drops tables.');
  }

  const mysql = await loadDriver();
  const connection = await mysql.createConnection({ uri: url, multipleStatements: true });

  try {
    const schema = await readFile(join(PROJECT, 'sql', 'schema.sql'), 'utf8');
    await connection.query(schema);
    console.log('  schema   done');

    // MySQL has no generate_series, so rows come from a numbers table built by
    // cross-joining a small seed set. Still one round trip per table.
    await connection.query(`
      CREATE TEMPORARY TABLE seq (i INT PRIMARY KEY);
      INSERT INTO seq (i)
      SELECT (a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 + f.d * 100000) + 1 AS i
        FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a
       CROSS JOIN (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b
       CROSS JOIN (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c
       CROSS JOIN (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) d
       CROSS JOIN (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) e
       CROSS JOIN (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) f
    `);

    await connection.query(
      `INSERT INTO authors (email, display_name, twitter, legacy_bio, created_at)
       SELECT
         CASE WHEN i <= 12 THEN NULL
              WHEN i <= 52 THEN 'shared@example.com'
              ELSE CONCAT('author', i, '@example.com') END,
         CONCAT('Author ', i),
         CASE WHEN i % 5 <> 0 THEN CONCAT('@handle', i) END,
         NULL,
         NOW() - INTERVAL (i % 900) DAY
       FROM seq WHERE i <= ?`,
      [AUTHORS],
    );
    console.log(`  authors  ${AUTHORS.toLocaleString()} rows`);

    await connection.query(
      `INSERT INTO posts (author_id, slug, status, view_count, published_at)
       SELECT
         CASE WHEN i <= 150 THEN ? + 100000 ELSE 1 + (i % ?) END,
         CONCAT('post-', i),
         CASE WHEN i % 7 = 0 THEN 'draft' ELSE 'published' END,
         (i * 13) % 90000,
         CASE WHEN i % 7 = 0 THEN NULL ELSE NOW() - INTERVAL (i % 720) HOUR END
       FROM seq WHERE i <= ?`,
      [AUTHORS, AUTHORS, POSTS],
    );
    console.log(`  posts    ${POSTS.toLocaleString()} rows`);

    await connection.query(
      `INSERT INTO comments (post_id, body, is_spam, created_at)
       SELECT 1 + (i % ?), CONCAT('comment body ', i), i % 9 = 0, NOW() - INTERVAL (i % 500) HOUR
         FROM seq WHERE i <= ?`,
      [POSTS, Math.min(COMMENTS, 999_999)],
    );
    console.log(`  comments ${COMMENTS.toLocaleString()} rows`);

    await connection.query('ANALYZE TABLE authors, posts, comments');
    console.log('\nSeeded.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
