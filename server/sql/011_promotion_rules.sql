ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_kind_check CHECK (kind IN ('percent','fixed','bogo','bundle'));
ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS starts_at timestamptz,
    ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'transaction' CHECK (scope IN ('transaction','product','category')),
    ADD COLUMN IF NOT EXISTS product_id uuid,
    ADD COLUMN IF NOT EXISTS category_id uuid,
    ADD COLUMN IF NOT EXISTS branch_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS usage_limit integer CHECK (usage_limit > 0),
    ADD COLUMN IF NOT EXISTS group_quantity integer CHECK (group_quantity BETWEEN 2 AND 100),
    ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false,
    ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id,id),
    ADD FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id,id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS promotion_id uuid;
CREATE INDEX orders_promotion_idx ON orders (tenant_id, promotion_id) WHERE promotion_id IS NOT NULL;
CREATE INDEX orders_legacy_promo_idx ON orders (tenant_id, upper(promo_code))
    WHERE promotion_id IS NULL AND promo_code IS NOT NULL;
