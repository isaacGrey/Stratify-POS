CREATE INDEX IF NOT EXISTS orders_branch_date_idx ON orders (tenant_id, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (tenant_id, spent_on);
