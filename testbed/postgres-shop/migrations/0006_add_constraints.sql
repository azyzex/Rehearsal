-- Three constraints, all of which look like tidying up, all of which fail.
-- Expected: blocking on each, with the count of offending rows.

-- 200 users point at an org that does not exist.
ALTER TABLE users
  ADD CONSTRAINT users_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs (id);

-- 150 orders point at a user that does not exist.
ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);

-- 40 users share one email address.
ALTER TABLE users
  ADD CONSTRAINT users_email_key UNIQUE (email);

-- Refunded orders were allowed to be zero, so this one has violations too.
ALTER TABLE orders
  ADD CONSTRAINT orders_total_positive CHECK (total_cents > 0);
