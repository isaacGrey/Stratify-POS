ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS client_sale_id uuid,
    ADD COLUMN IF NOT EXISTS checkout_fingerprint text,
    ADD COLUMN IF NOT EXISTS offline_device_id uuid,
    ADD COLUMN IF NOT EXISTS synced_at timestamptz,
    ADD COLUMN IF NOT EXISTS receipt_footer text;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS line_position integer,
    ADD COLUMN IF NOT EXISTS variation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_sale_unique
    ON orders (tenant_id, client_sale_id) WHERE client_sale_id IS NOT NULL;
