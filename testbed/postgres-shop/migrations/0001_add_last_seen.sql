-- Baseline: everything here is green.
-- If the panel flags any of this, the severity rules are too eager.

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

ALTER TABLE orgs ADD COLUMN billing_email text;

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   integer,
  action     text NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now()
);
