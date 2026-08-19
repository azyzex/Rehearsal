-- Expected: blocking. This does not lose data — it fails outright, partway
-- through, leaving the schema half-migrated.
--
-- The panel should say how many rows break it, because that is what you need
-- in order to write the backfill that has to come first.

ALTER TABLE users ALTER COLUMN email SET NOT NULL;
