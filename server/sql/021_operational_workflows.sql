-- StratifyPOS development: auditable purchasing, registers and refunds.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS require_cash_register boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS register_session_id uuid;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('paid','partially_refunded','refunded'));

CREATE TABLE register_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL, cashier_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
 opening_cents integer NOT NULL CHECK(opening_cents BETWEEN 0 AND 100000000),
 counted_cents integer CHECK(counted_cents BETWEEN 0 AND 100000000),
 expected_cents integer, variance_cents integer,
 opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 closed_by uuid REFERENCES users(id),
 UNIQUE(tenant_id,id), FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 CHECK ((status='open' AND counted_cents IS NULL AND closed_at IS NULL)
    OR (status='closed' AND counted_cents IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX register_one_open_cashier ON register_sessions(tenant_id,cashier_id) WHERE status='open';
ALTER TABLE orders ADD CONSTRAINT orders_register_session_fk FOREIGN KEY(tenant_id,register_session_id)
 REFERENCES register_sessions(tenant_id,id);
CREATE INDEX register_branch_history_idx ON register_sessions(tenant_id,branch_id,opened_at DESC);

CREATE TABLE register_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL, session_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('sale','refund','cash_in','cash_out')),
 amount_cents integer NOT NULL CHECK(amount_cents<>0 AND abs(amount_cents)<=100000000),
 reason text NOT NULL DEFAULT '', reference_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES register_sessions(tenant_id,id),
 CHECK ((kind IN ('sale','cash_in') AND amount_cents>0) OR
        (kind IN ('refund','cash_out') AND amount_cents<0))
);
CREATE UNIQUE INDEX register_movement_source_unique ON register_movements(tenant_id,kind,reference_id)
 WHERE reference_id IS NOT NULL;
CREATE INDEX register_movement_session_idx ON register_movements(tenant_id,session_id,created_at);

CREATE TABLE sales_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 order_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 method text NOT NULL CHECK(method IN ('cash','gcash','maya','card','bank_transfer','store_credit','other')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500),
 register_session_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,register_session_id) REFERENCES register_sessions(tenant_id,id)
);
CREATE INDEX sales_refunds_order_idx ON sales_refunds(tenant_id,order_id,created_at);

CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL, supplier_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 reference text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'submitted'
    CHECK(status IN ('submitted','partially_received','received','cancelled')),
 notes text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id)
);
CREATE TABLE purchase_order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 purchase_order_id uuid NOT NULL, ingredient_id uuid NOT NULL,
 ordered_quantity numeric(14,3) NOT NULL CHECK(ordered_quantity>0),
 received_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=ordered_quantity),
 unit_cost_cents integer NOT NULL CHECK(unit_cost_cents BETWEEN 0 AND 100000000),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,purchase_order_id,ingredient_id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE purchase_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 purchase_order_id uuid NOT NULL, branch_id uuid NOT NULL, request_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);
CREATE TABLE purchase_receipt_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 receipt_id uuid NOT NULL, purchase_order_line_id uuid NOT NULL,
 quantity numeric(14,3) NOT NULL CHECK(quantity>0),
 unit_cost_cents integer NOT NULL CHECK(unit_cost_cents>=0),
 UNIQUE(tenant_id,receipt_id,purchase_order_line_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES purchase_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_line_id) REFERENCES purchase_order_lines(tenant_id,id)
);
CREATE INDEX purchasing_branch_idx ON purchase_orders(tenant_id,branch_id,created_at DESC);

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['register_sessions','register_movements','sales_refunds','purchase_orders',
 'purchase_order_lines','purchase_receipts','purchase_receipt_lines'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['register_sessions','register_movements','sales_refunds','purchase_orders','purchase_receipts'] LOOP
  EXECUTE format('CREATE POLICY branch_scope ON %I AS RESTRICTIVE USING (app_branch_visible(branch_id)) WITH CHECK (app_branch_visible(branch_id))',tab);
 END LOOP;
END $$;
CREATE POLICY purchase_line_branch ON purchase_order_lines AS RESTRICTIVE
 USING (EXISTS(SELECT 1 FROM purchase_orders p WHERE p.tenant_id=purchase_order_lines.tenant_id AND p.id=purchase_order_lines.purchase_order_id))
 WITH CHECK(EXISTS(SELECT 1 FROM purchase_orders p WHERE p.tenant_id=purchase_order_lines.tenant_id AND p.id=purchase_order_lines.purchase_order_id));
CREATE POLICY purchase_receipt_line_branch ON purchase_receipt_lines AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM purchase_receipts p WHERE p.tenant_id=purchase_receipt_lines.tenant_id AND p.id=purchase_receipt_lines.receipt_id))
 WITH CHECK(EXISTS(SELECT 1 FROM purchase_receipts p WHERE p.tenant_id=purchase_receipt_lines.tenant_id AND p.id=purchase_receipt_lines.receipt_id));

GRANT SELECT,INSERT,UPDATE ON register_sessions,purchase_orders,purchase_order_lines TO coffee_saas_runtime;
GRANT SELECT,INSERT ON register_movements,sales_refunds,purchase_receipts,purchase_receipt_lines TO coffee_saas_runtime;

-- Operational ledgers cannot be rewritten even by accidental privileged SQL.
CREATE OR REPLACE FUNCTION prevent_operational_ledger_change() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Operational ledger records are append-only' USING ERRCODE='42501'; END
$$;
CREATE TRIGGER immutable_register_movements BEFORE UPDATE OR DELETE OR TRUNCATE ON register_movements
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();
CREATE TRIGGER immutable_sales_refunds BEFORE UPDATE OR DELETE OR TRUNCATE ON sales_refunds
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();
CREATE TRIGGER immutable_purchase_receipts BEFORE UPDATE OR DELETE OR TRUNCATE ON purchase_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();
CREATE TRIGGER immutable_purchase_receipt_lines BEFORE UPDATE OR DELETE OR TRUNCATE ON purchase_receipt_lines
 FOR EACH STATEMENT EXECUTE FUNCTION prevent_operational_ledger_change();
