-- Seed data for manual testing of Aperium PSQL against this sidecar postgres.
-- Mounted by docker-compose as a /docker-entrypoint-initdb.d script, so it
-- only runs on the very first boot (when the data volume is empty).

CREATE SCHEMA IF NOT EXISTS shop;

CREATE TABLE shop.customer (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    full_name   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE shop.product (
    id          SERIAL PRIMARY KEY,
    sku         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE shop.order (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES shop.customer(id) ON DELETE CASCADE,
    placed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status      TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled'))
);

CREATE TABLE shop.order_item (
    order_id    INTEGER NOT NULL REFERENCES shop.order(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES shop.product(id),
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id)
);

CREATE INDEX idx_order_customer ON shop.order(customer_id);
CREATE INDEX idx_order_status ON shop.order(status);

INSERT INTO shop.customer (email, full_name) VALUES
    ('alice@example.com', 'Alice Martin'),
    ('bob@example.com',   'Bob Durand'),
    ('carol@example.com', 'Carol N''Guyen');

INSERT INTO shop.product (sku, name, price_cents) VALUES
    ('SKU-001', 'Mechanical keyboard', 12900),
    ('SKU-002', 'USB-C hub',            3490),
    ('SKU-003', '27" monitor',         29900),
    ('SKU-004', 'Desk mat',             1990);

INSERT INTO shop.order (customer_id, status) VALUES
    (1, 'paid'),
    (1, 'shipped'),
    (2, 'pending'),
    (3, 'cancelled');

INSERT INTO shop.order_item (order_id, product_id, quantity) VALUES
    (1, 1, 1),
    (1, 2, 2),
    (2, 3, 1),
    (2, 4, 1),
    (3, 2, 1);
