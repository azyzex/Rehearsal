-- The original story. "Nobody uses phone_number, let's clean it up."
--
-- Expected: destructive. The panel must state how many rows actually have a
-- value, because that number is the entire reason not to run this.

ALTER TABLE users DROP COLUMN phone_number;
