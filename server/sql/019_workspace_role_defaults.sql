CREATE TABLE workspace_role_permissions (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    role text NOT NULL CHECK (role IN ('manager','cashier','staff')),
    permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id,role)
);
ALTER TABLE workspace_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_role_permissions
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON workspace_role_permissions TO coffee_saas_runtime;

ALTER TABLE work_schedules DROP CONSTRAINT IF EXISTS work_schedules_ends_at_check;
ALTER TABLE work_schedules ADD CONSTRAINT work_schedules_distinct_hours CHECK (ends_at<>starts_at);
