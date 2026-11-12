ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS gcash_reference_no text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false;

-- Change the legacy default while preserving custom durations and existing trials.
UPDATE plans SET trial_days = 5 WHERE id = 'free' AND trial_days IN (0, 3);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coffee_saas_runtime') THEN
        CREATE ROLE coffee_saas_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'coffee_saas_runtime'
        AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR rolinherit)
    ) THEN
        RAISE EXCEPTION 'coffee_saas_runtime must be a restricted NOLOGIN role';
    END IF;
END $$;

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
