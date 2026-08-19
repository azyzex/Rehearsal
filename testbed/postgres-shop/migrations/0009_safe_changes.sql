-- The credibility file. Every statement here is genuinely safe, and the panel
-- has to render an all-green screen without a single hedge.
--
-- This matters more than the red cases. A tool that flags everything is a tool
-- people turn off, and then it is not there on the day it would have mattered.

-- nickname was added, never used, and is NULL in every row. Dropping it loses
-- nothing, and the panel must say 'safe' rather than 'DROP COLUMN, be careful'.
ALTER TABLE users DROP COLUMN nickname;

-- The same index as 0004, built the right way. No lock, no outage.
CREATE INDEX CONCURRENTLY idx_orders_status_safe ON orders (status);

-- Nullable, no default, no rewrite.
ALTER TABLE orders ADD COLUMN gift_note text;

CREATE TABLE shipping_zones (
  id   serial PRIMARY KEY,
  name text NOT NULL
);
