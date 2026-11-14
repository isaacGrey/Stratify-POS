-- Per-sale cost snapshots: preserve historical costs when product or stock prices change.
-- NULL estimated_cogs_cents on legacy orders means cost data is unavailable, not zero.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_cogs_cents bigint
    CHECK (estimated_cogs_cents IS NULL OR estimated_cogs_cents >= 0);

CREATE TABLE order_cost_components (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    branch_id uuid NOT NULL,
    order_id uuid NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('stock','product')),
    source_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
    unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0),
    extended_cost_cents numeric(22,3) NOT NULL CHECK (extended_cost_cents >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id),
    FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);
CREATE INDEX order_cost_order_idx ON order_cost_components (tenant_id,order_id);

ALTER TABLE order_cost_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_cost_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON order_cost_components
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY branch_scope ON order_cost_components AS RESTRICTIVE
    USING (app_branch_visible(branch_id)) WITH CHECK (app_branch_visible(branch_id));
GRANT SELECT,INSERT ON order_cost_components TO coffee_saas_runtime;

CREATE TRIGGER immutable_order_cost_components BEFORE UPDATE OR DELETE OR TRUNCATE ON order_cost_components
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();

CREATE FUNCTION prevent_checkout_cost_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF OLD.estimated_cogs_cents IS DISTINCT FROM NEW.estimated_cogs_cents THEN
        RAISE EXCEPTION 'Posted transaction cost snapshots are immutable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER order_cost_snapshot_immutable BEFORE UPDATE OF estimated_cogs_cents ON orders
    FOR EACH ROW EXECUTE FUNCTION prevent_checkout_cost_update();
