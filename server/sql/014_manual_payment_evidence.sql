CREATE TABLE subscription_payment_methods (
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
    ('other', 'Other', '', false);

INSERT INTO subscription_payment_methods (id, name)
SELECT DISTINCT method, method FROM subscription_payments
WHERE method ~ '^[a-z][a-z0-9_]{1,31}$'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_method_check;
ALTER TABLE subscription_payments
    ADD FOREIGN KEY (method) REFERENCES subscription_payment_methods(id),
    ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS submitted_reference text,
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS verified_reference text,
    ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
    ADD COLUMN IF NOT EXISTS instructions_snapshot text;

CREATE UNIQUE INDEX subscription_verified_reference_idx ON subscription_payments (method, verified_reference)
    WHERE verified_reference IS NOT NULL;
CREATE UNIQUE INDEX subscription_claimed_reference_idx ON subscription_payments (method, submitted_reference)
    WHERE submitted_reference IS NOT NULL AND status IN ('pending','paid');
CREATE INDEX subscription_legacy_gcash_lookup_idx
    ON subscription_payments (upper(trim(gcash_reference_no))) WHERE method='gcash' AND status='paid';

ALTER TABLE plan_change_requests ADD COLUMN IF NOT EXISTS requested_payment_method text
    REFERENCES subscription_payment_methods(id);

CREATE TABLE subscription_payment_receipts (
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
