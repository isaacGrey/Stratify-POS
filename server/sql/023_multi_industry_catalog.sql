-- Multi-industry product identification and direct stock links.
-- Existing products remain food/menu items to preserve their behavior.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'food_beverage'
    CHECK (product_type IN ('physical','service','food_beverage','bundle','non_stock')),
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS manufacturer text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS stock_item_id uuid,
  ADD CONSTRAINT product_direct_stock_fk FOREIGN KEY (tenant_id,stock_item_id)
    REFERENCES ingredients(tenant_id,id);

UPDATE products SET sku='P-' || upper(substr(replace(id::text,'-',''),1,12))
 WHERE sku IS NULL OR btrim(sku)='';

ALTER TABLE products ADD CONSTRAINT product_identifier_lengths CHECK
  (length(sku)<=64 AND (barcode IS NULL OR length(barcode)<=128)
   AND length(brand)<=120 AND length(manufacturer)<=120);
CREATE UNIQUE INDEX products_tenant_sku_unique ON products(tenant_id,lower(sku))
 WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX products_tenant_barcode_unique ON products(tenant_id,lower(barcode))
 WHERE barcode IS NOT NULL;

ALTER TABLE variations
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS stock_item_id uuid,
  ADD CONSTRAINT variation_direct_stock_fk FOREIGN KEY (tenant_id,stock_item_id)
    REFERENCES ingredients(tenant_id,id);
ALTER TABLE variations ADD CONSTRAINT variation_identifier_lengths CHECK
  ((sku IS NULL OR length(sku)<=64) AND (barcode IS NULL OR length(barcode)<=128));
CREATE UNIQUE INDEX variations_tenant_sku_unique ON variations(tenant_id,lower(sku))
 WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX variations_tenant_barcode_unique ON variations(tenant_id,lower(barcode))
 WHERE barcode IS NOT NULL;
