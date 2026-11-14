-- Unique SKU and barcode registry across products and all their variations.
-- Prevents a barcode from identifying multiple saleable items in one tenant.
CREATE TABLE catalog_identifiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('sku','barcode')),
 identifier text NOT NULL CHECK(length(identifier)>0 AND length(identifier)<=128),
 owner_kind text NOT NULL CHECK(owner_kind IN ('product','variation')),
 owner_id uuid NOT NULL,
 UNIQUE(tenant_id,owner_kind,owner_id,kind)
);
CREATE UNIQUE INDEX catalog_identifiers_value_unique
 ON catalog_identifiers(tenant_id,kind,lower(identifier));

INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
 SELECT tenant_id,'sku',sku,'product',id FROM products WHERE sku IS NOT NULL;
INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
 SELECT tenant_id,'barcode',barcode,'product',id FROM products WHERE barcode IS NOT NULL;
INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
 SELECT tenant_id,'sku',sku,'variation',id FROM variations WHERE sku IS NOT NULL;
INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
 SELECT tenant_id,'barcode',barcode,'variation',id FROM variations WHERE barcode IS NOT NULL;

ALTER TABLE catalog_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_identifiers
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON catalog_identifiers TO coffee_saas_runtime;

CREATE FUNCTION update_catalog_identifiers() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public AS $$
DECLARE entity_kind text;
BEGIN
 entity_kind:=CASE TG_TABLE_NAME WHEN 'products' THEN 'product' ELSE 'variation' END;
 IF TG_OP='DELETE' OR TG_OP='UPDATE' THEN
  DELETE FROM catalog_identifiers WHERE tenant_id=OLD.tenant_id
   AND owner_kind=entity_kind AND owner_id=OLD.id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.sku IS NOT NULL THEN
  INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
   VALUES(NEW.tenant_id,'sku',NEW.sku,entity_kind,NEW.id);
 END IF;
 IF NEW.barcode IS NOT NULL THEN
  INSERT INTO catalog_identifiers(tenant_id,kind,identifier,owner_kind,owner_id)
   VALUES(NEW.tenant_id,'barcode',NEW.barcode,entity_kind,NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_identifiers_products
 AFTER INSERT OR UPDATE OF sku,barcode OR DELETE ON products
 FOR EACH ROW EXECUTE FUNCTION update_catalog_identifiers();
CREATE TRIGGER catalog_identifiers_variations
 AFTER INSERT OR UPDATE OF sku,barcode OR DELETE ON variations
 FOR EACH ROW EXECUTE FUNCTION update_catalog_identifiers();
