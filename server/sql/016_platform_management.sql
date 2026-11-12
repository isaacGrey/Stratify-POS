ALTER TABLE users
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE TABLE platform_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    public_name text NOT NULL DEFAULT 'StratifyPOS',
    support_email text NOT NULL DEFAULT '',
    maintenance_mode boolean NOT NULL DEFAULT false
);
INSERT INTO platform_settings(singleton) VALUES (true);

CREATE TABLE platform_audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid,
    action text NOT NULL,
    target text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_date_idx ON platform_audit_logs (created_at DESC,id DESC);
CREATE FUNCTION deny_platform_audit_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Platform audit entries are append-only' USING ERRCODE='42501';
END
$$;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
    ON platform_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION deny_platform_audit_changes();
REVOKE ALL ON platform_audit_logs, platform_settings FROM PUBLIC, coffee_saas_runtime;

CREATE TABLE subscription_promotions (
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
