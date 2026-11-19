-- Business type controls restaurant-only workflows without rewriting historical tickets.
ALTER TABLE tenants ADD COLUMN business_type text NOT NULL DEFAULT 'food'
 CHECK (business_type IN ('food','non_food'));
ALTER TABLE shop_settings ADD COLUMN kitchen_enabled boolean NOT NULL DEFAULT true;
UPDATE shop_settings SET kitchen_enabled=false
 WHERE tenant_id IN (SELECT id FROM tenants WHERE business_type='non_food');

-- Platform notifications use durable audit/payment sources. Read acknowledgements
-- are per administrator, not destructive event mutations.
CREATE TABLE platform_notification_reads (
 admin_id uuid NOT NULL REFERENCES users(id),
 notification_key text NOT NULL CHECK(length(notification_key) BETWEEN 3 AND 120),
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(admin_id,notification_key)
);
REVOKE ALL ON platform_notification_reads FROM PUBLIC,coffee_saas_runtime;

-- Schedules are tenant/branch scoped and resources are explicitly reserved.
-- The exclusion constraint is concurrency-safe even with two receptionists booking together.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE customer_appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 customer_id uuid,
 client_name text NOT NULL CHECK(length(btrim(client_name)) BETWEEN 1 AND 160),
 client_contact text NOT NULL DEFAULT '' CHECK(length(client_contact)<=160),
 service_name text NOT NULL CHECK(length(btrim(service_name)) BETWEEN 1 AND 160),
 requirements text NOT NULL DEFAULT '' CHECK(length(requirements)<=1500),
 resource_key text NOT NULL DEFAULT 'default' CHECK(length(btrim(resource_key)) BETWEEN 1 AND 80),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN
  ('pending','confirmed','rescheduled','completed','cancelled')),
 created_by uuid NOT NULL REFERENCES users(id),
 updated_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES service_customers(tenant_id,id),
 CHECK(ends_at>starts_at),
 CONSTRAINT appointments_no_conflicts EXCLUDE USING gist (
   tenant_id WITH =,branch_id WITH =,resource_key WITH =,
   tstzrange(starts_at,ends_at,'[)') WITH &&
 ) WHERE (status IN ('pending','confirmed','rescheduled'))
);
CREATE INDEX appointment_filter_idx
 ON customer_appointments(tenant_id,branch_id,starts_at,status);
ALTER TABLE customer_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant_scope ON customer_appointments
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY appointments_branch_scope ON customer_appointments AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON customer_appointments TO coffee_saas_runtime;

CREATE TABLE customer_appointment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 appointment_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),
 event_kind text NOT NULL CHECK(event_kind IN ('created','updated','rescheduled','status_changed')),
 previous_status text,
 new_status text NOT NULL,
 note text NOT NULL DEFAULT '' CHECK(length(note)<=300),
 occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,appointment_id) REFERENCES customer_appointments(tenant_id,id)
);
CREATE INDEX appointment_history_idx ON customer_appointment_events
 (tenant_id,appointment_id,occurred_at,id);
ALTER TABLE customer_appointment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_appointment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_event_tenant_scope ON customer_appointment_events
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY appointment_event_branch_scope ON customer_appointment_events AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT ON customer_appointment_events TO coffee_saas_runtime;
CREATE TRIGGER appointment_events_immutable
 BEFORE UPDATE OR DELETE OR TRUNCATE ON customer_appointment_events
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();

-- Owner-controlled classification update is restricted to the active tenant context.
CREATE FUNCTION set_tenant_business_type(p_type text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid;
BEGIN
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF tenant IS NULL OR p_type NOT IN ('food','non_food') THEN
  RAISE EXCEPTION 'Invalid tenant context or business type' USING ERRCODE='42501';
 END IF;
 UPDATE public.tenants SET business_type=p_type WHERE id=tenant;
 IF NOT FOUND THEN RAISE EXCEPTION 'Business not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION set_tenant_business_type(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_business_type(text) TO coffee_saas_runtime;
