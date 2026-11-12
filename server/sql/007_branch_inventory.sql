ALTER TABLE ingredients
    ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'ingredient'
        CHECK (item_type IN ('ingredient','product','supply','material','other')),
    ADD COLUMN IF NOT EXISTS inventory_category text NOT NULL DEFAULT '';

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS branch_stock_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS movement_type text,
    ADD COLUMN IF NOT EXISTS actor_id uuid;

CREATE TABLE branch_stock_balances (
    tenant_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (tenant_id, ingredient_id, branch_id),
    FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id,id),
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id,id)
);

CREATE INDEX branch_stock_location_idx ON branch_stock_balances (tenant_id, branch_id);
CREATE INDEX stock_movements_location_idx ON stock_movements (tenant_id, branch_id, created_at DESC);
ALTER TABLE branch_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON branch_stock_balances
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branch_stock_balances TO coffee_saas_runtime;
REVOKE UPDATE, DELETE ON stock_movements FROM coffee_saas_runtime;
