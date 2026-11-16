-- StratifyPOS: distinguish commercial product type from preparation class.
-- Do not erase legacy sales, recipe links or existing customer entitlements.
ALTER TABLE products ADD COLUMN product_class text;
ALTER TABLE products ADD COLUMN track_inventory boolean NOT NULL DEFAULT true;

UPDATE products SET product_class=CASE
  WHEN product_type='food_beverage' THEN 'food_beverage'
  WHEN product_type='service' THEN 'general_service'
  ELSE 'general_merchandise' END,
 track_inventory=CASE WHEN product_type IN ('service','non_stock') THEN false ELSE true END;
UPDATE products SET product_type='physical'
 WHERE product_type IN ('food_beverage','bundle','non_stock');
UPDATE products SET product_type='membership',product_class='membership_plan',track_inventory=false
 WHERE id IN (SELECT product_id FROM service_plans WHERE service_plans.tenant_id=products.tenant_id);
ALTER TABLE products ALTER COLUMN product_type SET DEFAULT 'physical';
ALTER TABLE products ALTER COLUMN product_class SET DEFAULT 'general_merchandise';
ALTER TABLE products ALTER COLUMN product_class SET NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
ALTER TABLE products ADD CONSTRAINT products_product_type_check
 CHECK (product_type IN ('physical','service','membership'));
ALTER TABLE products ADD CONSTRAINT products_class_type_check CHECK (
 (product_type='physical' AND product_class IN ('food_beverage','general_merchandise'))
 OR (product_type='service' AND product_class IN ('food_beverage','general_service'))
 OR (product_type='membership' AND product_class='membership_plan'));
ALTER TABLE products ADD CONSTRAINT products_inventory_type_check
 CHECK (track_inventory=false OR product_type='physical' OR product_class='food_beverage');

-- A non-food order has a first-class, non-restaurant sales mode.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check
 CHECK (order_type IN ('standard','dine_in','takeout','delivery'));
ALTER TABLE parked_orders DROP CONSTRAINT IF EXISTS parked_orders_order_type_check;
ALTER TABLE parked_orders ALTER COLUMN order_type SET DEFAULT 'standard';
ALTER TABLE parked_orders ADD CONSTRAINT parked_orders_order_type_check
 CHECK (order_type IN ('standard','dine_in','takeout','delivery'));

-- Membership plans are sellable only after the owner opts in.
ALTER TABLE service_plans ADD COLUMN sell_through_pos boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN service_customer_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_service_customer_fk FOREIGN KEY(tenant_id,service_customer_id)
 REFERENCES service_customers(tenant_id,id);
ALTER TABLE parked_orders ADD COLUMN service_customer_id uuid;
ALTER TABLE parked_orders ADD CONSTRAINT parked_orders_service_customer_fk FOREIGN KEY(tenant_id,service_customer_id)
 REFERENCES service_customers(tenant_id,id);
ALTER TABLE order_items ADD COLUMN product_class text;
UPDATE order_items oi SET product_class=p.product_class
 FROM products p WHERE p.tenant_id=oi.tenant_id AND p.id=oi.product_id;

-- Link changes to the paid sale and its reversing cash refund.
ALTER TABLE service_entitlement_events ADD COLUMN source_order_id uuid;
ALTER TABLE service_entitlement_events ADD COLUMN source_refund_id uuid;
ALTER TABLE service_entitlement_events ADD CONSTRAINT service_events_order_fk FOREIGN KEY(tenant_id,source_order_id)
 REFERENCES orders(tenant_id,id);
ALTER TABLE service_entitlement_events ADD CONSTRAINT service_events_refund_fk FOREIGN KEY(tenant_id,source_refund_id)
 REFERENCES sales_refunds(tenant_id,id);
ALTER TABLE service_entitlement_events DROP CONSTRAINT IF EXISTS service_entitlement_events_event_kind_check;
ALTER TABLE service_entitlement_events ADD CONSTRAINT service_events_kind_check
 CHECK(event_kind IN ('grant','renew','cancel','reverse'));
CREATE UNIQUE INDEX service_event_paid_sale_once ON service_entitlement_events(tenant_id,source_order_id,entitlement_id)
 WHERE source_order_id IS NOT NULL AND event_kind IN ('grant','renew');
CREATE UNIQUE INDEX service_event_refund_once ON service_entitlement_events(tenant_id,source_refund_id,entitlement_id)
 WHERE source_refund_id IS NOT NULL;

-- Index for fast POS plan lookup.
CREATE INDEX service_plans_pos_catalog_idx ON service_plans(tenant_id,product_id)
 WHERE active=true AND sell_through_pos=true;
