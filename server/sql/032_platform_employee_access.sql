-- Separate platform permissions from merchant-editable role and member preferences.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS admin_module_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS admin_workspace_enabled boolean NOT NULL DEFAULT true;
-- No implicit grants are backfilled. A business's explicitly saved overrides remain valid.
