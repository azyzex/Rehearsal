-- The demo file. This is the one the README GIF is recorded against.
--
-- Four statements, four severities, in the order the panel mockup in the spec
-- shows them: red, red, amber, green. A file that looks completely ordinary
-- and would ruin your afternoon.

ALTER TABLE users DROP COLUMN phone_number;

ALTER TABLE users ALTER COLUMN email SET NOT NULL;

CREATE INDEX idx_orders_status ON orders (status);

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
