ALTER TABLE variations
    ADD COLUMN IF NOT EXISTS price_cents integer CHECK (price_cents >= 0),
    ADD COLUMN IF NOT EXISTS use_custom_recipe boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS variations_product_idx ON variations (tenant_id, product_id);

CREATE TABLE variation_recipes (
    tenant_id uuid NOT NULL,
    variation_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (tenant_id, variation_id, ingredient_id),
    FOREIGN KEY (tenant_id, variation_id) REFERENCES variations(tenant_id,id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id,id)
);

CREATE TABLE addon_recipes (
    tenant_id uuid NOT NULL,
    addon_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (tenant_id, addon_id, ingredient_id),
    FOREIGN KEY (tenant_id, addon_id) REFERENCES addons(tenant_id,id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id,id)
);

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['variation_recipes', 'addon_recipes'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;
