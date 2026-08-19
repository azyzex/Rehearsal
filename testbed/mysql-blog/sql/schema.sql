-- Dry Run testbed: MySQL. Staged for v2.
--
-- Same idea as postgres-shop, different engine. The shapes that matter are the
-- same: a column that looks unused but is not, nulls where a NOT NULL is about
-- to be added, orphans, duplicates, and a table big enough that an index build
-- costs something.
--
-- The reason this is v2 and not v1: MySQL commits DDL implicitly. There is no
-- transactional DDL, so the execute-and-discard mechanism does not apply to
-- ALTER TABLE at all. DML previews port over unchanged; DDL stays probe-only.

DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS authors;

CREATE TABLE authors (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NULL,
  display_name VARCHAR(120) NOT NULL,
  twitter     VARCHAR(80) NULL,
  legacy_bio  TEXT NULL,
  created_at  DATETIME NOT NULL
) ENGINE=InnoDB;

CREATE TABLE posts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  author_id   INT NOT NULL,
  slug        VARCHAR(200) NOT NULL,
  status      VARCHAR(20) NOT NULL,
  view_count  INT NOT NULL DEFAULT 0,
  published_at DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE comments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  post_id    INT NOT NULL,
  body       TEXT NOT NULL,
  is_spam    TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB;
