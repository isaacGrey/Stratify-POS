-- New capabilities are additive; preserve all existing subscriptions and tenants.
-- Existing tenants remain food-enabled until the owner explicitly classifies them.
ALTER TABLE tenants ADD COLUMN business_type text NOT NULL DEFAULT 'food'
  CHECK (business_type IN ('food','non_food'));
ALTER TABLE shop_settings ADD COLUMN kitchen_enabled boolean NOT NULL DEFAULT true;
UPDATE shop_settings SET kitchen_enabled=false
 WHERE tenant_id IN (SELECT id FROM tenants WHERE business_type='non_food');

-- Appointments may overlap at different branches or resources but not at the same resource.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE customer_appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 customer_id uuid,
 customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 160),
 contact text NOT NULL DEFAULT '' CHECK (length(contact)<=180),
 service_name text NOT NULL CHECK (length(btrim(service_name)) BETWEEN 1 AND 160),
 resource_name text NOT NULL DEFAULT 'General' CHECK (length(btrim(resource_name)) BETWEEN 1 AND 120),
 requirements text NOT NULL DEFAULT '' CHECK (length(requirements)<=2000),
 notes text NOT NULL DEFAULT '' CHECK (length(notes)<=2000),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rescheduled','completed','cancelled')),
 created_by uuid NOT NULL REFERENCES users(id),
 updated_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id),
 FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY (tenant_id,customer_id) REFERENCES service_customers(tenant_id,id),
 CHECK (ends_at > starts_at),
 CHECK (ends_at <= starts_at + interval '24 hours'),
 EXCLUDE USING gist (
   tenant_id WITH =, branch_id WITH =, resource_name WITH =,
   tstzrange(starts_at,ends_at,'[)') WITH &&
 ) WHERE (status IN ('pending','confirmed','rescheduled'))
);
CREATE INDEX appointments_tenant_time ON customer_appointments(tenant_id,starts_at,branch_id);
CREATE INDEX appointments_customer ON customer_appointments(tenant_id,customer_id);
ALTER TABLE customer_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant_scope ON customer_appointments
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY appointments_branch_scope ON customer_appointments AS RESTRICTIVE
 USING (app_branch_visible(branch_id)) WITH CHECK (app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON customer_appointments TO coffee_saas_runtime;

CREATE TABLE platform_notification_reads (
 notification_key text PRIMARY KEY CHECK(length(notification_key) BETWEEN 4 AND 160),
 read_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON platform_notification_reads FROM PUBLIC,coffee_saas_runtime;
