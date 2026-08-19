-- Not a real migration. This file exists to break the statement splitter, and
-- is the fixture for the M1 parser work.
--
-- Every construct below has a semicolon or a keyword in a place where naive
-- splitting gets it wrong. There are 8 numbered cases and 9 statements — case
-- 8 is two of them on one line — so the panel must show exactly 9 rows.

-- 1. Semicolon inside a string literal.
INSERT INTO orgs (name) VALUES ('acme; holdings');

-- 2. Doubled quote inside a string, followed by a semicolon inside it.
INSERT INTO orgs (name) VALUES ('o''brien; and sons');

-- 3. A dollar-quoted function body containing semicolons, BEGIN, and COMMIT.
--    The body is one statement. The words inside it are not statements.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. A custom dollar-quote tag, nested inside another one.
CREATE OR REPLACE FUNCTION nested_quotes() RETURNS text AS $outer$
BEGIN
  RETURN $inner$ a string; with a semicolon $inner$;
END;
$outer$ LANGUAGE plpgsql;

-- 5. A nested block comment containing a statement that must not be counted.
/* outer
   /* inner: DELETE FROM users; */
   still commented: DROP TABLE orders;
*/
SELECT 1;

-- 6. CASE ... END, which ends with the transaction-control keyword END but is
--    not transaction control.
UPDATE users
   SET tier = CASE WHEN tier = 'free' THEN 'starter' ELSE tier END
 WHERE id < 10;

-- 7. A quoted identifier that is a reserved word.
SELECT "select" FROM (SELECT 1 AS "select") AS t;

-- 8. Statements crammed onto one line.
SELECT 1; SELECT 2;
