ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_kind_check CHECK (kind IN ('percent','fixed','bogo','bundle','loyalty'));
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS points_required integer CHECK (points_required > 0);
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS loyalty_cents_per_point integer NOT NULL DEFAULT 10000
    CHECK (loyalty_cents_per_point > 0);

CREATE TABLE loyalty_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,
    name text NOT NULL,
    points bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
    UNIQUE (tenant_id,id),
    UNIQUE (tenant_id,code)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_account_id uuid,
    ADD FOREIGN KEY (tenant_id,loyalty_account_id) REFERENCES loyalty_accounts(tenant_id,id);

CREATE TABLE loyalty_movements (
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    order_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('earned','redeemed')),
    points integer NOT NULL CHECK ((kind='earned' AND points > 0) OR (kind='redeemed' AND points < 0)),
    PRIMARY KEY (tenant_id,order_id,kind),
    FOREIGN KEY (tenant_id,account_id) REFERENCES loyalty_accounts(tenant_id,id),
    FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id) ON DELETE CASCADE
);

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['loyalty_accounts', 'loyalty_movements'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
    END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON loyalty_accounts TO coffee_saas_runtime;
GRANT SELECT, INSERT ON loyalty_movements TO coffee_saas_runtime;
