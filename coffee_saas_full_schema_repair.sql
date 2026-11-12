-- Coffee SaaS schema alignment: 001/003 restored backup + migrations 004-020.
-- Review and BACK UP your database before running. Execute in pgAdmin Query Tool
-- on the database specified in server/.env (not the default postgres database).
-- This operation is transaction-wrapped and does not drop user tables or records.
BEGIN;
SET LOCAL search_path TO public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.tenants') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.subscription_payments') IS NULL
  THEN
    RAISE EXCEPTION 'Expected restored Coffee SaaS baseline missing. Stop: wrong database or incomplete restore.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The original application queries workspace data as coffee_saas_runtime.
-- Do not grant BYPASSRLS or superuser to this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='coffee_saas_runtime') THEN
    CREATE ROLE coffee_saas_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;



-- 004 baseline compatibility
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS gcash_reference_no text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false;

-- Change the legacy default while preserving custom durations and existing trials.
UPDATE plans SET trial_days = 5 WHERE id = 'free' AND trial_days IN (0, 3);

-- Role existence checked above; role hardening needs a separate, planned connection change.

GRANT USAGE ON SCHEMA public TO coffee_saas_runtime;
GRANT SELECT ON plans TO coffee_saas_runtime;
GRANT SELECT (id, name, email, active) ON users TO coffee_saas_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    memberships, subscriptions, invites, branches, categories, products, variations,
    addons, ingredients, recipes, suppliers, stock_movements, tables, promotions,
    orders, order_items, expenses, attendance, shop_settings
TO coffee_saas_runtime;
GRANT SELECT, INSERT ON audit_logs TO coffee_saas_runtime;
GRANT USAGE ON SEQUENCE order_number_seq TO coffee_saas_runtime;
REVOKE ALL ON FUNCTION public.invitation_tenant(text) FROM PUBLIC;


-- 005 checkout reconciliation
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS client_sale_id uuid,
    ADD COLUMN IF NOT EXISTS checkout_fingerprint text,
    ADD COLUMN IF NOT EXISTS offline_device_id uuid,
    ADD COLUMN IF NOT EXISTS synced_at timestamptz,
    ADD COLUMN IF NOT EXISTS receipt_footer text;

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS line_position integer,
    ADD COLUMN IF NOT EXISTS variation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_sale_unique
    ON orders (tenant_id, client_sale_id) WHERE client_sale_id IS NOT NULL;


-- 006 catalog options
ALTER TABLE variations
    ADD COLUMN IF NOT EXISTS price_cents integer CHECK (price_cents >= 0),
    ADD COLUMN IF NOT EXISTS use_custom_recipe boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS variations_product_idx ON variations (tenant_id, product_id);

CREATE TABLE IF NOT EXISTS variation_recipes (
    tenant_id uuid NOT NULL,
    variation_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (tenant_id, variation_id, ingredient_id),
    FOREIGN KEY (tenant_id, variation_id) REFERENCES variations(tenant_id,id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS addon_recipes (
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
        EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;


-- 007 branch inventory
ALTER TABLE ingredients
    ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'ingredient'
        CHECK (item_type IN ('ingredient','product','supply','material','other')),
    ADD COLUMN IF NOT EXISTS inventory_category text NOT NULL DEFAULT '';

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS branch_stock_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS movement_type text,
    ADD COLUMN IF NOT EXISTS actor_id uuid;

CREATE TABLE IF NOT EXISTS branch_stock_balances (
    tenant_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (tenant_id, ingredient_id, branch_id),
    FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id,id),
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id,id)
);

CREATE INDEX IF NOT EXISTS branch_stock_location_idx ON branch_stock_balances (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS stock_movements_location_idx ON stock_movements (tenant_id, branch_id, created_at DESC);
ALTER TABLE branch_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_stock_balances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON branch_stock_balances;
CREATE POLICY tenant_scope ON branch_stock_balances
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON branch_stock_balances TO coffee_saas_runtime;
REVOKE UPDATE, DELETE ON stock_movements FROM coffee_saas_runtime;


-- 008 report indexes
CREATE INDEX IF NOT EXISTS orders_branch_date_idx ON orders (tenant_id, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (tenant_id, spent_on);


-- 009 attendance scheduling
ALTER TABLE attendance
    ADD COLUMN IF NOT EXISTS managed_session boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
    ADD COLUMN IF NOT EXISTS late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0);

-- Legacy open records remain intact. Every new session uses the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_managed_open_idx
    ON attendance (tenant_id, user_id) WHERE managed_session AND clock_out IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_tenant_id_idx ON attendance (tenant_id, id);
CREATE INDEX IF NOT EXISTS attendance_user_date_idx ON attendance (tenant_id, user_id, clock_in DESC);

CREATE TABLE IF NOT EXISTS attendance_breaks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    attendance_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz CHECK (ended_at >= started_at),
    FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendance(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_open_break_idx
    ON attendance_breaks (tenant_id, attendance_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_break_history_idx ON attendance_breaks (tenant_id, attendance_id, started_at);

CREATE TABLE IF NOT EXISTS work_schedules (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    branch_id uuid,
    starts_at time NOT NULL,
    ends_at time NOT NULL CHECK (ends_at > starts_at),
    time_zone text NOT NULL,
    grace_minutes integer NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 180),
    PRIMARY KEY (tenant_id,user_id,weekday),
    FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['attendance_breaks', 'work_schedules'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;

GRANT INSERT (name,email,password_hash) ON users TO coffee_saas_runtime;


-- 010 branch operations
ALTER TABLE branches ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Manila';

CREATE TABLE IF NOT EXISTS branch_weekly_hours (
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

CREATE TABLE IF NOT EXISTS branch_date_overrides (
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
    ADD COLUMN IF NOT EXISTS active_order_id uuid;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.tables'::regclass AND conname='tables_active_order_fk') THEN
        ALTER TABLE public.tables ADD CONSTRAINT tables_active_order_fk
          FOREIGN KEY (tenant_id, active_order_id)
          REFERENCES public.orders(tenant_id,id) ON DELETE SET NULL (active_order_id);
    END IF;
END $$;

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['branch_weekly_hours', 'branch_date_overrides'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;


-- 011 promotion rules
-- Final kind constraint with loyalty is applied in 012. Set it here
-- to avoid rejecting existing loyalty promotions on reruns.
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_kind_check CHECK (kind IN ('percent','fixed','bogo','bundle','loyalty'));
ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS starts_at timestamptz,
    ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'transaction' CHECK (scope IN ('transaction','product','category')),
    ADD COLUMN IF NOT EXISTS product_id uuid,
    ADD COLUMN IF NOT EXISTS category_id uuid,
    ADD COLUMN IF NOT EXISTS branch_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS usage_limit integer CHECK (usage_limit > 0),
    ADD COLUMN IF NOT EXISTS group_quantity integer CHECK (group_quantity BETWEEN 2 AND 100),
    ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.promotions'::regclass AND conname='promotions_tenant_id_product_id_fkey') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_tenant_id_product_id_fkey FOREIGN KEY (tenant_id,product_id) REFERENCES public.products(tenant_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.promotions'::regclass AND conname='promotions_tenant_id_category_id_fkey') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_tenant_id_category_id_fkey FOREIGN KEY (tenant_id,category_id) REFERENCES public.categories(tenant_id,id);
  END IF;
END $$;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS promotion_id uuid;
CREATE INDEX IF NOT EXISTS orders_promotion_idx ON orders (tenant_id, promotion_id) WHERE promotion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_legacy_promo_idx ON orders (tenant_id, upper(promo_code))
    WHERE promotion_id IS NULL AND promo_code IS NOT NULL;


-- 012 loyalty rewards
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_kind_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_kind_check CHECK (kind IN ('percent','fixed','bogo','bundle','loyalty'));
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS points_required integer CHECK (points_required > 0);
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS loyalty_cents_per_point integer NOT NULL DEFAULT 10000
    CHECK (loyalty_cents_per_point > 0);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,
    name text NOT NULL,
    points bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
    UNIQUE (tenant_id,id),
    UNIQUE (tenant_id,code)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_account_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_tenant_id_loyalty_account_id_fkey') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_tenant_id_loyalty_account_id_fkey FOREIGN KEY (tenant_id, loyalty_account_id) REFERENCES public.loyalty_accounts(tenant_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS loyalty_movements (
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
        EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
    END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON loyalty_accounts TO coffee_saas_runtime;
GRANT SELECT, INSERT ON loyalty_movements TO coffee_saas_runtime;


-- 013 plan change requests
CREATE TABLE IF NOT EXISTS plan_change_requests (
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

CREATE UNIQUE INDEX IF NOT EXISTS plan_change_open_idx ON plan_change_requests (tenant_id)
    WHERE status IN ('pending','awaiting_payment');
CREATE INDEX IF NOT EXISTS plan_change_history_idx ON plan_change_requests (tenant_id, created_at DESC);
ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON plan_change_requests;
CREATE POLICY tenant_scope ON plan_change_requests
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON plan_change_requests TO coffee_saas_runtime;


-- 014 manual payment evidence
CREATE TABLE IF NOT EXISTS subscription_payment_methods (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,31}$'),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
    customer_enabled boolean NOT NULL DEFAULT false,
    CHECK (NOT customer_enabled OR length(trim(instructions)) > 0)
);

INSERT INTO subscription_payment_methods (id, name, instructions, customer_enabled) VALUES
    ('gcash', 'GCash', 'Contact StratifyPOS support for the current merchant payment details before sending payment.', true),
    ('maya', 'Maya', '', false),
    ('maribank', 'MariBank', '', false),
    ('bank_transfer', 'Bank transfer', '', false),
    ('cash', 'Cash', '', false),
    ('card', 'Card', '', false),
    ('other', 'Other', '', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription_payment_methods (id, name)
SELECT DISTINCT method, method FROM subscription_payments
WHERE method ~ '^[a-z][a-z0-9_]{1,31}$'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_method_check;
ALTER TABLE subscription_payments
    ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submitted_reference text,
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS verified_reference text,
    ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
    ADD COLUMN IF NOT EXISTS instructions_snapshot text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.subscription_payments'::regclass AND conname='subscription_payments_method_fkey') THEN
    ALTER TABLE public.subscription_payments ADD CONSTRAINT subscription_payments_method_fkey FOREIGN KEY(method) REFERENCES public.subscription_payment_methods(id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_verified_reference_idx ON subscription_payments (method, verified_reference)
    WHERE verified_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_claimed_reference_idx ON subscription_payments (method, submitted_reference)
    WHERE submitted_reference IS NOT NULL AND status IN ('pending','paid');
CREATE INDEX IF NOT EXISTS subscription_legacy_gcash_lookup_idx
    ON subscription_payments (upper(trim(gcash_reference_no))) WHERE method='gcash' AND status='paid';

ALTER TABLE plan_change_requests ADD COLUMN IF NOT EXISTS requested_payment_method text
    REFERENCES subscription_payment_methods(id);

CREATE TABLE IF NOT EXISTS subscription_payment_receipts (
    payment_id uuid PRIMARY KEY REFERENCES subscription_payments(id) ON DELETE CASCADE,
    uploaded_by uuid NOT NULL,
    mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg')),
    source_hash text NOT NULL CHECK (length(source_hash)=64),
    contents bytea NOT NULL CHECK (octet_length(contents) BETWEEN 1 AND 5242880),
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscription_payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payment_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON subscription_payment_receipts FROM PUBLIC, coffee_saas_runtime;
GRANT SELECT ON subscription_payment_methods TO coffee_saas_runtime;


-- 015 workspace access
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

CREATE OR REPLACE FUNCTION app_branch_visible(branch uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT nullif(current_setting('app.branch_ids', true), '') IS NULL
        OR COALESCE(branch = ANY(nullif(current_setting('app.branch_ids', true), '')::uuid[]),false)
$$;

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['orders','tables','stock_movements','expenses',
        'branch_stock_balances','branch_weekly_hours','branch_date_overrides'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS branch_scope ON %I', relation);
        EXECUTE format('CREATE POLICY branch_scope ON %I AS RESTRICTIVE
            USING (app_branch_visible(branch_id)) WITH CHECK (app_branch_visible(branch_id))', relation);
    END LOOP;
END $$;

DROP POLICY IF EXISTS branch_scope ON branches;
CREATE POLICY branch_scope ON branches AS RESTRICTIVE
    USING (app_branch_visible(id)) WITH CHECK (app_branch_visible(id));
DROP POLICY IF EXISTS branch_scope ON order_items;
CREATE POLICY branch_scope ON order_items AS RESTRICTIVE
    USING (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id=order_items.tenant_id AND o.id=order_items.order_id))
    WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id=order_items.tenant_id AND o.id=order_items.order_id));
DROP POLICY IF EXISTS branch_scope ON attendance;
CREATE POLICY branch_scope ON attendance AS RESTRICTIVE
    USING (app_branch_visible(branch_id) OR
        (branch_id IS NULL AND user_id=nullif(current_setting('app.user_id',true),'')::uuid))
    WITH CHECK (app_branch_visible(branch_id) OR
        (branch_id IS NULL AND user_id=nullif(current_setting('app.user_id',true),'')::uuid));
DROP POLICY IF EXISTS branch_scope ON attendance_breaks;
CREATE POLICY branch_scope ON attendance_breaks AS RESTRICTIVE
    USING (EXISTS (SELECT 1 FROM attendance a WHERE a.tenant_id=attendance_breaks.tenant_id AND a.id=attendance_breaks.attendance_id))
    WITH CHECK (EXISTS (SELECT 1 FROM attendance a WHERE a.tenant_id=attendance_breaks.tenant_id AND a.id=attendance_breaks.attendance_id));


-- 016 platform management (platform_settings + subscription_promotions)
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    public_name text NOT NULL DEFAULT 'StratifyPOS',
    support_email text NOT NULL DEFAULT '',
    maintenance_mode boolean NOT NULL DEFAULT false
);
INSERT INTO platform_settings(singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid,
    action text NOT NULL,
    target text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_date_idx ON platform_audit_logs (created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION deny_platform_audit_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Platform audit entries are append-only' USING ERRCODE='42501';
END
$$;
DROP TRIGGER IF EXISTS platform_audit_immutable ON platform_audit_logs;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
    ON platform_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION deny_platform_audit_changes();
REVOKE ALL ON platform_audit_logs, platform_settings FROM PUBLIC, coffee_saas_runtime;

CREATE TABLE IF NOT EXISTS subscription_promotions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    code text UNIQUE,
    plan_id text REFERENCES plans(id),
    kind text NOT NULL CHECK (kind IN ('fixed','percent')),
    value integer NOT NULL CHECK (value>0 AND (kind<>'percent' OR value<100)),
    starts_at timestamptz,
    expires_at timestamptz,
    active boolean NOT NULL DEFAULT true,
    CHECK (starts_at IS NULL OR expires_at IS NULL OR starts_at<expires_at)
);
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS subscription_promotion_id uuid REFERENCES subscription_promotions(id);
ALTER TABLE plan_change_requests ADD COLUMN IF NOT EXISTS discount_code text;
REVOKE ALL ON subscription_promotions FROM PUBLIC, coffee_saas_runtime;
GRANT SELECT ON subscription_promotions TO coffee_saas_runtime;


-- 017 database recovery
CREATE TABLE IF NOT EXISTS backup_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly','monthly')),
    hour_utc smallint NOT NULL DEFAULT 18 CHECK (hour_utc BETWEEN 0 AND 23),
    weekday_utc smallint NOT NULL DEFAULT 0 CHECK (weekday_utc BETWEEN 0 AND 6),
    month_day_utc smallint NOT NULL DEFAULT 1 CHECK (month_day_utc BETWEEN 1 AND 28),
    retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
    changed_at timestamptz NOT NULL DEFAULT now(),
    worker_heartbeat timestamptz
);
INSERT INTO backup_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS backup_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('backup','restore')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    source_backup_id uuid REFERENCES backup_jobs(id),
    schedule_slot timestamptz UNIQUE,
    requested_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    size_bytes bigint CHECK (size_bytes > 0),
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error text,
    notification_status text,
    delete_requested_at timestamptz,
    deleted_at timestamptz,
    CHECK ((kind='restore')=(source_backup_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS backup_jobs_date_idx ON backup_jobs (created_at DESC,id);
CREATE INDEX IF NOT EXISTS backup_jobs_queued_idx ON backup_jobs (created_at) WHERE status='queued';
CREATE UNIQUE INDEX IF NOT EXISTS backup_single_restore_idx ON backup_jobs ((kind)) WHERE kind='restore' AND status IN ('queued','running');
REVOKE ALL ON backup_settings,backup_jobs FROM PUBLIC,coffee_saas_runtime;


-- 018 public inquiries
CREATE TABLE IF NOT EXISTS public_inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL,
    business text NOT NULL DEFAULT '',
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS public_inquiries_date_idx ON public_inquiries (created_at DESC,id);
REVOKE ALL ON public_inquiries FROM PUBLIC,coffee_saas_runtime;


-- 019 workspace role defaults
CREATE TABLE IF NOT EXISTS workspace_role_permissions (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    role text NOT NULL CHECK (role IN ('manager','cashier','staff')),
    permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id,role)
);
ALTER TABLE workspace_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON workspace_role_permissions;
CREATE POLICY tenant_scope ON workspace_role_permissions
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON workspace_role_permissions TO coffee_saas_runtime;

ALTER TABLE work_schedules DROP CONSTRAINT IF EXISTS work_schedules_ends_at_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.work_schedules'::regclass AND conname='work_schedules_distinct_hours') THEN
    ALTER TABLE public.work_schedules ADD CONSTRAINT work_schedules_distinct_hours CHECK (ends_at<>starts_at);
  END IF;
END $$;


-- 020 overnight schedule compatibility
ALTER TABLE work_schedules DROP CONSTRAINT IF EXISTS work_schedules_check;



-- Synchronize migration history: the baseline was verified above and the
-- complete additive 004-020 changes have now been executed in this transaction.
INSERT INTO public.schema_migrations (filename)
VALUES
  ('001_initial.sql'),
  ('003_superadmin_billing.sql'),
  ('004_baseline_compatibility.sql'),
  ('005_checkout_reconciliation.sql'),
  ('006_catalog_options.sql'),
  ('007_branch_inventory.sql'),
  ('008_report_indexes.sql'),
  ('009_attendance_scheduling.sql'),
  ('010_branch_operations.sql'),
  ('011_promotion_rules.sql'),
  ('012_loyalty_rewards.sql'),
  ('013_plan_change_requests.sql'),
  ('014_manual_payment_evidence.sql'),
  ('015_workspace_access.sql'),
  ('016_platform_management.sql'),
  ('017_database_recovery.sql'),
  ('018_public_inquiries.sql'),
  ('019_workspace_role_defaults.sql'),
  ('020_overnight_schedule_compatibility.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;

-- Verify schema after COMMIT (run separately if pgAdmin only displays last result).
SELECT
  current_database() AS database_name,
  to_regclass('public.platform_settings') AS platform_settings,
  to_regclass('public.subscription_promotions') AS subscription_promotions,
  to_regclass('public.workspace_role_permissions') AS workspace_role_permissions,
  (SELECT count(*) FROM public.schema_migrations) AS migration_rows;
