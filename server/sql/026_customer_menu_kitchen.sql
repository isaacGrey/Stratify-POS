-- Customer menu requests are not sales. Only paid POS transactions enter the kitchen queue.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS customer_menu_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public_menu_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 table_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 UNIQUE(tenant_id,table_id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,table_id) REFERENCES tables(tenant_id,id)
);
CREATE INDEX public_menu_links_branch_idx ON public_menu_links(tenant_id,branch_id);
ALTER TABLE public_menu_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_menu_links FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_tenant_scope ON public_menu_links
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY menu_branch_scope ON public_menu_links AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON public_menu_links TO coffee_saas_runtime;

CREATE TABLE customer_order_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 table_id uuid NOT NULL,
 cart jsonb NOT NULL CHECK(jsonb_typeof(cart)='array'),
 request_fingerprint text NOT NULL CHECK(length(request_fingerprint)=64),
 status text NOT NULL DEFAULT 'awaiting_payment'
   CHECK(status IN ('awaiting_payment','payment_review','confirmed','cancelled')),
 payment_method text NOT NULL CHECK(payment_method IN ('cash','gcash','maya','card')),
 payment_reference text CHECK(length(payment_reference)<=120),
 quoted_total_cents bigint NOT NULL CHECK(quoted_total_cents>=0),
 order_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 confirmed_by uuid REFERENCES users(id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,table_id) REFERENCES tables(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,order_id),
 CHECK ((status='confirmed' AND order_id IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (status<>'confirmed' AND order_id IS NULL))
);
CREATE INDEX customer_requests_branch_idx ON customer_order_requests(tenant_id,branch_id,created_at DESC);
CREATE UNIQUE INDEX customer_requests_reference_idx ON customer_order_requests
  (tenant_id,payment_method,lower(payment_reference)) WHERE payment_reference IS NOT NULL;
ALTER TABLE customer_order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY requests_tenant_scope ON customer_order_requests
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY requests_branch_scope ON customer_order_requests AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON customer_order_requests TO coffee_saas_runtime;

CREATE TABLE kitchen_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 branch_id uuid NOT NULL,
 order_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending'
   CHECK(status IN ('pending','preparing','ready','completed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 updated_by uuid REFERENCES users(id),
 UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES branches(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE INDEX kitchen_tickets_active_idx ON kitchen_tickets(tenant_id,branch_id,created_at)
 WHERE status<>'completed';
ALTER TABLE kitchen_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_tenant_scope ON kitchen_tickets
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY kitchen_branch_scope ON kitchen_tickets AS RESTRICTIVE
 USING(app_branch_visible(branch_id)) WITH CHECK(app_branch_visible(branch_id));
GRANT SELECT,INSERT,UPDATE ON kitchen_tickets TO coffee_saas_runtime;
