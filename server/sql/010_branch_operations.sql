ALTER TABLE branches ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Manila';

CREATE TABLE branch_weekly_hours (
    tenant_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    closed boolean NOT NULL DEFAULT false,
    opens_at time,
    closes_at time,
    PRIMARY KEY (tenant_id, branch_id, weekday),
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id,id) ON DELETE CASCADE,
    CHECK ((closed AND opens_at IS NULL AND closes_at IS NULL) OR
        (NOT closed AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at))
);

CREATE TABLE branch_date_overrides (
    tenant_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    day date NOT NULL,
    label text NOT NULL DEFAULT '',
    closed boolean NOT NULL DEFAULT false,
    opens_at time,
    closes_at time,
    PRIMARY KEY (tenant_id, branch_id, day),
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id,id) ON DELETE CASCADE,
    CHECK ((closed AND opens_at IS NULL AND closes_at IS NULL) OR
        (NOT closed AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at))
);

ALTER TABLE tables
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'available'
        CHECK (status IN ('available','occupied','reserved','unavailable')),
    ADD COLUMN IF NOT EXISTS active_order_id uuid,
    ADD CONSTRAINT tables_active_order_fk FOREIGN KEY (tenant_id, active_order_id)
        REFERENCES orders(tenant_id,id) ON DELETE SET NULL (active_order_id);

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['branch_weekly_hours', 'branch_date_overrides'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;
