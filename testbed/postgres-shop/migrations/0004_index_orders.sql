-- Expected: blocking. The index itself is a good idea; building it this way is
-- not. Without CONCURRENTLY this takes an ACCESS EXCLUSIVE lock on orders and
-- blocks every write for the duration of the build.
--
-- The panel should report the table size and an estimated build time, clearly
-- marked as an estimate — and should point out that the CONCURRENTLY form of
-- the same statement is green.

CREATE INDEX idx_orders_user_id ON orders (user_id);

CREATE INDEX idx_orders_placed_at ON orders (placed_at DESC);
