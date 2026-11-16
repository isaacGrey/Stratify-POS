-- Merchant customer services/memberships are separate from StratifyPOS SaaS subscriptions.
-- Duration is stored as calendar months or calendar days, never 30-day approximations.
CREATE TABLE service_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 product_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
 description text NOT NULL DEFAULT '',
 duration_kind text NOT NULL CHECK(duration_kind IN ('none','months','days')),
 duration_value integer,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK((duration_kind='none' AND duration_value IS NULL) OR
       (duration_kind='months' AND duration_value BETWEEN 1 AND 120) OR
       (duration_kind='days' AND duration_value BETWEEN 1 AND 3650))
);
CREATE TABLE service_customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
 email text CHECK(email IS NULL OR length(email)<=254),
 phone text CHECK(phone IS NULL OR length(phone)<=40),
 reference text CHECK(reference IS NULL OR length(reference)<=80),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX service_customer_reference_unique ON service_customers(tenant_id,lower(reference))
 WHERE reference IS NOT NULL;
CREATE INDEX service_customers_search_idx ON service_customers(tenant_id,name);
CREATE TABLE service_entitlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 starts_on date NOT NULL,
 expires_on date,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
 granted_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES service_customers(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES service_plans(tenant_id,id),
 CHECK(expires_on IS NULL OR expires_on >= starts_on)
);
CREATE INDEX service_entitlements_customer_idx ON service_entitlements(tenant_id,customer_id);
CREATE INDEX service_entitlements_expiry_idx ON service_entitlements(tenant_id,expires_on)
 WHERE status='active' AND expires_on IS NOT NULL;
CREATE TABLE service_entitlement_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 entitlement_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),
 event_kind text NOT NULL CHECK(event_kind IN ('grant','renew','cancel')),
 previous_expires_on date,
 starts_on date NOT NULL,
 expires_on date,
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=500),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,entitlement_id) REFERENCES service_entitlements(tenant_id,id)
);
CREATE INDEX service_entitlement_events_history_idx
 ON service_entitlement_events(tenant_id,entitlement_id,created_at,id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['service_plans','service_customers','service_entitlements','service_entitlement_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
CREATE POLICY branch_scope ON service_entitlements AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
CREATE POLICY branch_scope ON service_entitlement_events AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON service_plans,service_customers,service_entitlements TO coffee_saas_runtime;
GRANT SELECT,INSERT ON service_entitlement_events TO coffee_saas_runtime;
CREATE TRIGGER service_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON service_entitlement_events
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();
