-- Dry Run testbed: a small e-commerce schema, shaped so that every probe in
-- spec §6.2 has something real to find.
--
-- Deliberate omissions, each one there to make a migration interesting:
--   * users.org_id has no foreign key   -> ADD FOREIGN KEY finds orphans
--   * users.email has no unique index   -> ADD UNIQUE finds duplicates
--   * users.email is nullable           -> SET NOT NULL finds nulls
--   * users.nickname is never populated -> DROP COLUMN must report 'safe'
--   * orders is large and unindexed     -> CREATE INDEX has a real cost

DROP TABLE IF EXISTS carts;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS orgs;

CREATE TABLE orgs (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'standard',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text,
  tier          text NOT NULL DEFAULT 'free',
  phone_number  text,
  nickname      text,
  org_id        integer,
  signup_source text NOT NULL DEFAULT 'web',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  user_id     integer NOT NULL,
  status      text NOT NULL,
  total_cents integer NOT NULL,
  placed_at   timestamptz NOT NULL
);

CREATE TABLE carts (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL,
  item_count  integer NOT NULL,
  abandoned   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL
);
