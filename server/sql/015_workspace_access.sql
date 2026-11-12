ALTER TABLE plans ADD COLUMN IF NOT EXISTS module_access jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS module_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS administratively_suspended boolean NOT NULL DEFAULT false;
ALTER TABLE memberships
    ADD COLUMN IF NOT EXISTS module_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS branch_ids uuid[];

UPDATE tenants t SET administratively_suspended=true
FROM subscriptions s WHERE s.tenant_id=t.id AND t.status='suspended' AND t.archived_at IS NULL
    AND s.status IN ('trial','active','past_due','cancelled');

CREATE FUNCTION app_branch_visible(branch uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT nullif(current_setting('app.branch_ids', true), '') IS NULL
        OR COALESCE(branch = ANY(nullif(current_setting('app.branch_ids', true), '')::uuid[]),false)
$$;

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['orders','tables','stock_movements','expenses',
        'branch_stock_balances','branch_weekly_hours','branch_date_overrides'] LOOP
        EXECUTE format('CREATE POLICY branch_scope ON %I AS RESTRICTIVE
            USING (app_branch_visible(branch_id)) WITH CHECK (app_branch_visible(branch_id))', relation);
    END LOOP;
END $$;

CREATE POLICY branch_scope ON branches AS RESTRICTIVE
    USING (app_branch_visible(id)) WITH CHECK (app_branch_visible(id));
CREATE POLICY branch_scope ON order_items AS RESTRICTIVE
    USING (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id=order_items.tenant_id AND o.id=order_items.order_id))
    WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id=order_items.tenant_id AND o.id=order_items.order_id));
CREATE POLICY branch_scope ON attendance AS RESTRICTIVE
    USING (app_branch_visible(branch_id) OR
        (branch_id IS NULL AND user_id=nullif(current_setting('app.user_id',true),'')::uuid))
    WITH CHECK (app_branch_visible(branch_id) OR
        (branch_id IS NULL AND user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY branch_scope ON attendance_breaks AS RESTRICTIVE
    USING (EXISTS (SELECT 1 FROM attendance a WHERE a.tenant_id=attendance_breaks.tenant_id AND a.id=attendance_breaks.attendance_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attendance a WHERE a.tenant_id=attendance_breaks.tenant_id AND a.id=attendance_breaks.attendance_id));
