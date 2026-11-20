-- SaaS affiliate identities and financial records are platform-owned, never merchant-scoped.
-- No existing tenants are attributed retroactively. Referral codes are unrelated to
-- subscription promotional/discount codes.
ALTER TABLE platform_settings
    ADD COLUMN affiliate_default_rate_bps integer NOT NULL DEFAULT 2000
      CHECK (affiliate_default_rate_bps BETWEEN 0 AND 10000),
    ADD COLUMN affiliate_hold_days integer NOT NULL DEFAULT 14
      CHECK (affiliate_hold_days BETWEEN 0 AND 90),
    ADD COLUMN affiliate_min_payout_cents integer NOT NULL DEFAULT 100000
      CHECK (affiliate_min_payout_cents BETWEEN 100 AND 100000000);

CREATE TABLE affiliate_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    referral_code text NOT NULL UNIQUE
      CHECK (referral_code ~ '^[A-Z][A-Z0-9-]{4,31}$'),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    commission_rate_override_bps integer CHECK (commission_rate_override_bps BETWEEN 0 AND 10000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_accounts_status_idx ON affiliate_accounts(status);

-- A business is referred at most once, permanently at initial registration.
CREATE TABLE affiliate_referrals (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
    affiliate_id uuid NOT NULL REFERENCES affiliate_accounts(id) ON DELETE RESTRICT,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    referral_code_snapshot text NOT NULL,
    attributed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,affiliate_id)
);
CREATE INDEX affiliate_referrals_affiliate_idx ON affiliate_referrals(affiliate_id,attributed_at DESC);

-- Exactly one accrued commission per *verified subscription payment*; no POS orders.
-- Monetary snapshots may never be changed. A reversal is independently auditable.
CREATE TABLE affiliate_commissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id uuid NOT NULL UNIQUE REFERENCES subscription_payments(id) ON DELETE RESTRICT,
    tenant_id uuid NOT NULL,
    affiliate_id uuid NOT NULL REFERENCES affiliate_accounts(id) ON DELETE RESTRICT,
    eligible_amount_cents integer NOT NULL CHECK (eligible_amount_cents > 0),
    rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
    commission_cents integer NOT NULL CHECK (commission_cents > 0),
    available_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    reversed_at timestamptz,
    reversal_reason text CHECK (reversal_reason IS NULL OR length(reversal_reason) BETWEEN 1 AND 500),
    FOREIGN KEY (tenant_id,affiliate_id) REFERENCES affiliate_referrals(tenant_id,affiliate_id)
);
CREATE INDEX affiliate_commissions_affiliate_idx
    ON affiliate_commissions(affiliate_id,created_at DESC);
CREATE INDEX affiliate_commissions_pending_idx
    ON affiliate_commissions(affiliate_id,available_at)
    WHERE reversed_at IS NULL;

CREATE FUNCTION forbid_affiliate_commission_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.id,OLD.payment_id,OLD.tenant_id,OLD.affiliate_id,OLD.eligible_amount_cents,
     OLD.rate_bps,OLD.commission_cents,OLD.available_at,OLD.created_at)
    IS DISTINCT FROM
    (NEW.id,NEW.payment_id,NEW.tenant_id,NEW.affiliate_id,NEW.eligible_amount_cents,
     NEW.rate_bps,NEW.commission_cents,NEW.available_at,NEW.created_at)
    OR OLD.reversed_at IS NOT NULL OR
    (NEW.reversed_at IS NULL AND NEW.reversal_reason IS NOT NULL) OR
    (NEW.reversed_at IS NOT NULL AND (NEW.reversal_reason IS NULL OR length(NEW.reversal_reason)=0))
 THEN RAISE EXCEPTION 'Affiliate commissions are immutable except one reversal' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER affiliate_commission_integrity BEFORE UPDATE
    ON affiliate_commissions FOR EACH ROW EXECUTE FUNCTION forbid_affiliate_commission_rewrite();

CREATE TABLE affiliate_payouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id uuid NOT NULL REFERENCES affiliate_accounts(id) ON DELETE RESTRICT,
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    status text NOT NULL DEFAULT 'requested'
      CHECK (status IN ('requested','paid','rejected')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES users(id),
    payment_reference text CHECK (payment_reference IS NULL OR length(payment_reference) <= 120),
    review_note text NOT NULL DEFAULT '' CHECK(length(review_note) <= 500)
);
CREATE UNIQUE INDEX affiliate_payout_one_open_idx ON affiliate_payouts(affiliate_id)
    WHERE status='requested';
CREATE INDEX affiliate_payout_history_idx ON affiliate_payouts(affiliate_id,requested_at DESC);

-- Platform-only access. Business RLS runtime is explicitly denied even if it knows IDs.
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['affiliate_accounts','affiliate_referrals','affiliate_commissions','affiliate_payouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY affiliate_platform_only ON %I USING (false) WITH CHECK (false)',tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,coffee_saas_runtime',tbl);
 END LOOP;
END $$;
