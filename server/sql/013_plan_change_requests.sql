CREATE TABLE plan_change_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    requested_by uuid NOT NULL REFERENCES users(id),
    requested_plan_id text NOT NULL REFERENCES plans(id),
    approved_plan_id text REFERENCES plans(id),
    payment_id uuid UNIQUE REFERENCES subscription_payments(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_payment','applied','rejected')),
    review_note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz
);

CREATE UNIQUE INDEX plan_change_open_idx ON plan_change_requests (tenant_id)
    WHERE status IN ('pending','awaiting_payment');
CREATE INDEX plan_change_history_idx ON plan_change_requests (tenant_id, created_at DESC);
ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON plan_change_requests
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON plan_change_requests TO coffee_saas_runtime;
