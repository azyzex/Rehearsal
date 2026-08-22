-- Dry Run testbed: a small e-commerce schema.
--
-- Two jobs, deliberately in tension:
--
--   1. Give the schema explorer something with real shape to draw — twenty
--      tables, a proper web of foreign keys, a self-referencing hierarchy, and
--      a couple of junction tables with composite keys.
--
--   2. Keep the gaps the migration previews depend on. `users.org_id` and
--      `orders.user_id` are deliberately left WITHOUT foreign keys, because
--      0006_add_constraints.sql adds them and has to find orphans. Constraining
--      them here would quietly make that demo report "all valid".
--
-- So the new tables are properly related and the two original columns stay
-- loose. Anything left unconstrained below is unconstrained on purpose.

DROP TABLE IF EXISTS order_coupons CASCADE;
DROP TABLE IF EXISTS wishlist_items CASCADE;
DROP TABLE IF EXISTS wishlists CASCADE;
DROP TABLE IF EXISTS inventory_movements CASCADE;
DROP TABLE IF EXISTS cart_items CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS addresses CASCADE;
DROP TABLE IF EXISTS coupons CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS warehouses CASCADE;
DROP TABLE IF EXISTS countries CASCADE;
DROP TABLE IF EXISTS carts CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS orgs CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;

-- ---- the original four -----------------------------------------------------

CREATE TABLE orgs (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'standard',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text,
  tier          text NOT NULL DEFAULT 'free',
  phone_number  text,
  nickname      text,
  -- No foreign key: 0006_add_constraints.sql adds it and must find orphans.
  org_id        integer,
  signup_source text NOT NULL DEFAULT 'web',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  -- Also deliberately unconstrained, for the same reason.
  user_id     integer NOT NULL,
  status      text NOT NULL,
  total_cents integer NOT NULL,
  placed_at   timestamptz NOT NULL
);

CREATE TABLE carts (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_count  integer NOT NULL,
  abandoned   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL
);

-- ---- geography and supply --------------------------------------------------

CREATE TABLE countries (
  id    serial PRIMARY KEY,
  code  char(2) NOT NULL UNIQUE,
  name  text NOT NULL
);

CREATE TABLE warehouses (
  id          serial PRIMARY KEY,
  country_id  integer NOT NULL REFERENCES countries (id),
  name        text NOT NULL,
  capacity    integer NOT NULL
);

CREATE TABLE suppliers (
  id          serial PRIMARY KEY,
  country_id  integer NOT NULL REFERENCES countries (id),
  name        text NOT NULL,
  contact_email text
);

-- Self-referencing hierarchy: a category can sit under another category.
CREATE TABLE categories (
  id         serial PRIMARY KEY,
  parent_id  integer REFERENCES categories (id),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE
);

CREATE TABLE products (
  id            serial PRIMARY KEY,
  category_id   integer NOT NULL REFERENCES categories (id),
  supplier_id   integer REFERENCES suppliers (id),
  sku           text NOT NULL UNIQUE,
  name          text NOT NULL,
  price_cents   integer NOT NULL,
  discontinued  boolean NOT NULL DEFAULT false
);

-- ---- customers -------------------------------------------------------------

CREATE TABLE addresses (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  country_id  integer NOT NULL REFERENCES countries (id),
  line1       text NOT NULL,
  city        text NOT NULL,
  postcode    text
);

CREATE TABLE sessions (
  id          bigserial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  user_agent  text
);

CREATE TABLE wishlists (
  id       serial PRIMARY KEY,
  user_id  integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name     text NOT NULL DEFAULT 'Saved'
);

-- Junction table with a composite primary key.
CREATE TABLE wishlist_items (
  wishlist_id integer NOT NULL REFERENCES wishlists (id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products (id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wishlist_id, product_id)
);

-- ---- the order lifecycle ---------------------------------------------------

CREATE TABLE order_items (
  id               bigserial PRIMARY KEY,
  order_id         bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id       integer NOT NULL REFERENCES products (id),
  quantity         integer NOT NULL,
  unit_price_cents integer NOT NULL
);

CREATE TABLE payments (
  id            bigserial PRIMARY KEY,
  order_id      bigint NOT NULL REFERENCES orders (id),
  method        text NOT NULL,
  amount_cents  integer NOT NULL,
  status        text NOT NULL,
  captured_at   timestamptz
);

CREATE TABLE shipments (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders (id),
  address_id  integer NOT NULL REFERENCES addresses (id),
  carrier     text NOT NULL,
  tracking    text,
  shipped_at  timestamptz
);

CREATE TABLE coupons (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  discount_pct  integer NOT NULL,
  expires_at    timestamptz
);

-- Second junction table, so the diagram has more than one.
CREATE TABLE order_coupons (
  order_id   bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  coupon_id  integer NOT NULL REFERENCES coupons (id),
  PRIMARY KEY (order_id, coupon_id)
);

-- ---- operations ------------------------------------------------------------

CREATE TABLE reviews (
  id          bigserial PRIMARY KEY,
  product_id  integer NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating      integer NOT NULL,
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  id          bigserial PRIMARY KEY,
  cart_id     integer NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL
);

CREATE TABLE inventory_movements (
  id            bigserial PRIMARY KEY,
  product_id    integer NOT NULL REFERENCES products (id),
  warehouse_id  integer NOT NULL REFERENCES warehouses (id),
  delta         integer NOT NULL,
  reason        text NOT NULL,
  moved_at      timestamptz NOT NULL DEFAULT now()
);
