-- Expected: the first statement is destructive and must be flagged for the
-- missing WHERE clause specifically, not only for its row count. A DELETE with
-- no WHERE is a different kind of mistake from a DELETE that matches a lot of
-- rows, and the panel should say which one it is looking at.

DELETE FROM carts;

-- What was probably meant. Expected: caution, with a real count.
DELETE FROM carts
 WHERE abandoned
   AND updated_at < now() - interval '7 days';

-- Matches nothing. Expected: safe — and the panel has to say so plainly rather
-- than hedging, or nobody will believe the red rows either.
DELETE FROM carts WHERE item_count < 0;

-- Deliberate error case: audit_log is created by 0001, and previews never
-- commit, so unless you have actually applied 0001 this table does not exist.
-- Expected: this row alone shows "couldn't analyze — relation does not exist",
-- and every other row in the file still resolves normally.
TRUNCATE audit_log;
