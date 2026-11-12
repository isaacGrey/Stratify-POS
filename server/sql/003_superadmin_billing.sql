
-- CREMA COFFEE SAAS
-- SUPER ADMIN BILLING & SHOP ARCHIVING

-- Preserve shops when deleted from the active dashboard.
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Platform subscription payment ledger.
-- These are SaaS payments, NOT POS customer payments.

CREATE TABLE IF NOT EXISTS subscription_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id),

    plan_id TEXT NOT NULL
        REFERENCES plans(id),

    amount_cents INTEGER NOT NULL
        CHECK (amount_cents > 0),

    currency TEXT NOT NULL DEFAULT 'PHP'
        CHECK (currency = 'PHP'),

    method TEXT NOT NULL
        CHECK (
            method IN (
                'cash',
                'bank_transfer',
                'gcash',
                'maya',
                'card',
                'other'
            )
        ),

    reference_no TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'paid',
                'failed',
                'refunded'
            )
        ),

    paid_at TIMESTAMPTZ,

    period_start DATE,
    period_end DATE,

    notes TEXT NOT NULL DEFAULT '',

    recorded_by_user_id UUID
        REFERENCES users(id),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    CHECK (
        (
            period_start IS NULL
            AND period_end IS NULL
        )
        OR
        (
            period_start IS NOT NULL
            AND period_end IS NOT NULL
            AND period_end >= period_start
        )
    )
);

CREATE INDEX IF NOT EXISTS
subscription_payments_tenant_date_idx
ON subscription_payments (
    tenant_id,
    created_at DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS
subscription_payments_reference_unique_idx
ON subscription_payments (
    tenant_id,
    method,
    reference_no
);

-- Prevent regular shop roles from accessing the ledger
-- through tenant-scoped queries.

ALTER TABLE subscription_payments
ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscription_payments
FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
subscription_payments_admin_only
ON subscription_payments;

CREATE POLICY subscription_payments_admin_only
ON subscription_payments
USING (FALSE)
WITH CHECK (FALSE);

