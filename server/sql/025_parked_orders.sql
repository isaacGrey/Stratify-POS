-- Persisted POS drafts for online hold/park/resume.
-- Drafts never reserve stock, prices or tables. Final checkout revalidates all.
CREATE TABLE parked_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL,
  cashier_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','completed','cancelled')),
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
  order_type text NOT NULL DEFAULT 'takeout'
    CHECK(order_type IN ('dine_in','takeout','delivery')),
  table_id uuid,
  promo_code text,
  loyalty_code text,
  note text NOT NULL DEFAULT '' CHECK(length(note)<=300),
  request_fingerprint text NOT NULL CHECK(length(request_fingerprint)=64),
  completed_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY(tenant_id,table_id) REFERENCES tables(tenant_id,id),
  FOREIGN KEY(tenant_id,completed_order_id) REFERENCES orders(tenant_id,id),
  CHECK ((status='completed' AND completed_order_id IS NOT NULL AND completed_at IS NOT NULL)
      OR (status<>'completed' AND completed_order_id IS NULL AND completed_at IS NULL))
);
CREATE INDEX parked_orders_active_idx ON parked_orders(tenant_id,branch_id,updated_at DESC)
  WHERE status='held';
ALTER TABLE parked_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE parked_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON parked_orders
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY branch_scope ON parked_orders AS RESTRICTIVE
  USING(app_branch_visible(branch_id))
  WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON parked_orders TO coffee_saas_runtime;
