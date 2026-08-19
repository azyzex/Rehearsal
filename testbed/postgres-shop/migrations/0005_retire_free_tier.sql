-- DML, not DDL: this is the case where the statement really runs inside the
-- rolled-back transaction and the server reports the true count.
--
-- Expected: destructive on row count alone, with a before/after sample showing
-- the tier column changing.

UPDATE users
   SET tier = 'starter'
 WHERE tier = 'free';

-- Same shape, far smaller blast radius. Expected: caution or safe.
UPDATE users
   SET signup_source = 'ios'
 WHERE signup_source = 'android'
   AND created_at > now() - interval '30 days';

-- The classic. A WHERE clause that looks scoped but is not: `tier` is never
-- NULL, so this rewrites every row in the table.
UPDATE users
   SET tier = 'free'
 WHERE tier IS NOT NULL;
