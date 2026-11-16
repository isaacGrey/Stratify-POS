import { randomUUID } from 'node:crypto';
import { one, rows } from './db.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const badRequest = message => Object.assign(new Error(message), { status: 400 });

const catalogKinds = ['physical','service','membership'];
const catalogClasses = {
 physical:['food_beverage','general_merchandise'],
 service:['food_beverage','general_service'],
 membership:['membership_plan']
};
const automaticSku = prefix => prefix + '-' + randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();

export function identifier(value,label,max=64) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw badRequest('Invalid '+label);
    const normalized=value.trim().toUpperCase();
    if (!normalized) return null;
    if (normalized.length>max || !/^[A-Z0-9][A-Z0-9_.\/-]*$/.test(normalized)) {
        throw badRequest('Invalid '+label+': use letters, numbers, hyphens, dots or slashes');
    }
    return normalized;
}

function stringField(value,label,max) {
    if (typeof value !== 'string' || value.trim().length > max) throw badRequest('Invalid '+label);
    return value.trim();
}

export async function productOptions(db,tenant,input,existing=null) {
    const type = input.product_type ?? existing?.product_type ?? 'physical';
    if (!catalogKinds.includes(type)) throw badRequest('Invalid product type');
    if(type==='membership' && !existing)throw badRequest('Create membership items through Customer Memberships → Plans');
    if(existing?.product_type==='membership')throw badRequest('Edit linked membership items through Customer Memberships → Plans');
    // Existing API clients that omit the type created food/menu entries.
    const legacyFoodDefault=!existing && input.product_type===undefined && input.product_class===undefined;
    const itemClass=input.product_class ?? (type===existing?.product_type ? existing?.product_class : null)
       ?? (legacyFoodDefault?'food_beverage':type==='physical'?'general_merchandise':type==='service'?'general_service':'membership_plan');
    if(!catalogClasses[type].includes(itemClass))throw badRequest('Product class does not match the selected type');
    const trackInventory=input.track_inventory ?? (type===existing?.product_type ? existing?.track_inventory : type==='physical');
    if(typeof trackInventory!=='boolean'||(trackInventory&&type!=='physical'))
     throw badRequest('Only physical products may track inventory');
    const sku = input.sku === undefined
        ? existing?.sku || automaticSku('P')
        : identifier(input.sku,'SKU') || existing?.sku || automaticSku('P');
    const barcode = input.barcode === undefined
        ? existing?.barcode ?? null : identifier(input.barcode,'barcode',128);
    const brand = stringField(input.brand ?? existing?.brand ?? '', 'brand', 120);
    const manufacturer = stringField(input.manufacturer ?? existing?.manufacturer ?? '', 'manufacturer',120);
    const stockItem = input.stock_item_id === undefined
        ? existing?.stock_item_id ?? null : input.stock_item_id || null;
    if (stockItem && (!uuid.test(stockItem) ||
        !await one(db,'SELECT id FROM ingredients WHERE tenant_id=$1 AND id=$2',[tenant,stockItem]))) {
        throw badRequest('Select a valid stock item');
    }
    if (stockItem && (type !== 'physical'||!trackInventory)) throw badRequest('Direct stock tracking requires an inventory-tracked physical product');
    const image = input.image_url === undefined ? existing?.image_url ?? null : input.image_url || null;
    if (image !== null && (typeof image !== 'string' || image.length > 1024 ||
        !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/.test(image))) {
        throw badRequest('Product image must be a valid HTTPS URL');
    }
    return {product_type:type,product_class:itemClass,track_inventory:trackInventory,sku,barcode,brand,manufacturer,stock_item_id:stockItem,image_url:image};
}

export const catalogConflict = error => error?.code === '23505'
    ? Object.assign(new Error('SKU or barcode is already assigned in this business'), {status:409})
    : error;

export async function listProducts(db, tenant) {
    return rows(db, `
        SELECT p.*, c.name AS category,
            COALESCE(sp.sell_through_pos,false) AS sell_through_pos,
            COALESCE(sp.active,false) AS membership_plan_active,
            COALESCE(sizes.variations, '[]') AS variations,
            COALESCE(base.recipe, '[]') AS recipe
        FROM products p
        LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
        LEFT JOIN service_plans sp ON sp.tenant_id=p.tenant_id AND sp.product_id=p.id
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(to_jsonb(v) || jsonb_build_object('recipe', COALESCE(vr.recipe, '[]'))
                ORDER BY v.name, v.id) AS variations
            FROM variations v
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ingredient_id) AS recipe
                FROM variation_recipes r WHERE r.tenant_id=v.tenant_id AND r.variation_id=v.id
            ) vr ON true
            WHERE v.tenant_id=p.tenant_id AND v.product_id=p.id
        ) sizes ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ingredient_id) AS recipe
            FROM recipes r WHERE r.tenant_id=p.tenant_id AND r.product_id=p.id
        ) base ON true
        WHERE p.tenant_id=$1
        ORDER BY p.name, p.id
    `, [tenant]);
}

export async function replaceRecipe(db, tenant, type, id, recipe) {
    const [table, column] = {
        product: ['recipes', 'product_id'],
        variation: ['variation_recipes', 'variation_id'],
        addon: ['addon_recipes', 'addon_id']
    }[type];
    if (!Array.isArray(recipe) || recipe.length > 100) throw badRequest('Invalid recipe');
    const used = new Set();
    for (const line of recipe) {
        const quantity = Number(line?.quantity);
        if (!uuid.test(line?.ingredient_id) || !Number.isFinite(quantity) ||
            quantity < 0.001 || quantity > 1000000 ||
            Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001 ||
            used.has(line.ingredient_id)) throw badRequest('Invalid or duplicate recipe item');
        used.add(line.ingredient_id);
    }
    const ids = [...used];
    const found = await rows(db, 'SELECT id FROM ingredients WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenant, ids]);
    if (found.length !== ids.length) throw badRequest('Recipe ingredient is unavailable');
    await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND ${column}=$2`, [tenant, id]);
    for (const line of recipe) {
        await db.query(`INSERT INTO ${table} (tenant_id,${column},ingredient_id,quantity) VALUES($1,$2,$3,$4)`,
            [tenant, id, line.ingredient_id, line.quantity]);
    }
}

export async function saveVariations(db, tenant, product, variations) {
    if (!Array.isArray(variations) || variations.length > 100) throw badRequest('Invalid variations');
    const kept = new Set();
    for (const variation of variations) {
        const name = typeof variation?.name === 'string' && variation.name.trim();
        const delta = variation?.price_delta_cents ?? 0;
        const absolute = variation?.price_cents ?? null;
        const price = absolute ?? product.price_cents + delta;
        if (!name || name.length > 120 || !Number.isInteger(delta) || Math.abs(delta) > 100000000 ||
            !Number.isInteger(price) || price < 0 || price > 100000000 ||
            (variation.id && (!uuid.test(variation.id) || kept.has(variation.id)))) {
            throw badRequest('Invalid or duplicate variation');
        }
        const previous = variation.id ? await one(db,
            'SELECT sku,barcode,stock_item_id FROM variations WHERE tenant_id=$1 AND product_id=$2 AND id=$3',
            [tenant,product.id,variation.id]) : null;
        if (variation.id && !previous) throw badRequest('Variation does not belong to this product');
        const sku = variation.sku === undefined
            ? previous?.sku || automaticSku('V')
            : identifier(variation.sku,'variation SKU') || previous?.sku || automaticSku('V');
        const barcode = variation.barcode === undefined ? previous?.barcode ?? null
            : identifier(variation.barcode,'variation barcode',128);
        const stockItem = variation.stock_item_id === undefined ? previous?.stock_item_id ?? null
            : variation.stock_item_id || null;
        if (stockItem && (product.product_type !== 'physical' || !product.track_inventory || !uuid.test(stockItem) ||
            !await one(db,'SELECT id FROM ingredients WHERE tenant_id=$1 AND id=$2',[tenant,stockItem]))) {
            throw badRequest('Direct variation stock is only available for physical products');
        }
        const useRecipe = variation.use_custom_recipe === true;
        const values = [tenant, product.id, name,
            absolute === null ? delta : absolute - product.price_cents,
            absolute, useRecipe, sku, barcode, stockItem];
        let saved;
        try {
            saved = variation.id
                ? await one(db, 'UPDATE variations SET name=$3,price_delta_cents=$4,price_cents=$5,' +
                    'use_custom_recipe=$6,sku=$7,barcode=$8,stock_item_id=$9 ' +
                    'WHERE tenant_id=$1 AND product_id=$2 AND id=$10 RETURNING id',
                    [...values,variation.id])
                : await one(db, 'INSERT INTO variations ' +
                    '(tenant_id,product_id,name,price_delta_cents,price_cents,use_custom_recipe,sku,barcode,stock_item_id) ' +
                    'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',values);
        } catch (error) { throw catalogConflict(error); }
        if (useRecipe && variation.recipe !== undefined) {
            await replaceRecipe(db,tenant,'variation',saved.id,variation.recipe);
        }
        kept.add(saved.id);
    }
    await db.query('DELETE FROM variations WHERE tenant_id=$1 AND product_id=$2 AND NOT (id=ANY($3::uuid[]))',
        [tenant,product.id,[...kept]]);
}
