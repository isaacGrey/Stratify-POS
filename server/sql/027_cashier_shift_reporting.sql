-- Registers are cashier-owned and may overlap at a branch during shift handovers.
-- A cashier can have at most one open register per business at once (existing index).
CREATE INDEX IF NOT EXISTS register_session_actor_time ON register_sessions
 (tenant_id,cashier_id,opened_at DESC);
CREATE INDEX IF NOT EXISTS order_cash_register_time ON orders
 (tenant_id,register_session_id,created_at) WHERE register_session_id IS NOT NULL;

-- Prevent unauthorised reassignments of existing kitchen tickets to another sale.
CREATE FUNCTION kitchen_ticket_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.branch_id<>OLD.branch_id OR NEW.order_id<>OLD.order_id THEN
  RAISE EXCEPTION 'Kitchen ticket identity is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kitchen_ticket_identity_immutable BEFORE UPDATE ON kitchen_tickets
 FOR EACH ROW EXECUTE FUNCTION kitchen_ticket_identity_guard();
