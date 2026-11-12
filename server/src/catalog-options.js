import { one, rows } from './db.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const badRequest = message => Object.assign(new Error(message), { status: 400 });

export async function listProducts(db, tenant) {
    return rows(db, `
        SELECT p.*, c.name AS category,
            COALESCE(sizes.variations, '[]') AS variations,
            COALESCE(base.recipe, '[]') AS recipe
        FROM products p
        LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
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
            throw badRequest('Invalid or duplicate size');
        }
        const useRecipe = variation.use_custom_recipe === true;
        const values = [tenant, product.id, name, absolute === null ? delta : absolute - product.price_cents,
            absolute, useRecipe];
        const saved = variation.id
            ? await one(db, `UPDATE variations SET name=$3, price_delta_cents=$4, price_cents=$5, use_custom_recipe=$6
                WHERE tenant_id=$1 AND product_id=$2 AND id=$7 RETURNING id`, [...values, variation.id])
            : await one(db, `INSERT INTO variations (tenant_id,product_id,name,price_delta_cents,price_cents,use_custom_recipe)
                VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, values);
        if (!saved) throw badRequest('Size does not belong to this product');
        if (useRecipe && variation.recipe !== undefined) {
            await replaceRecipe(db, tenant, 'variation', saved.id, variation.recipe);
        }
        kept.add(saved.id);
    }
    await db.query('DELETE FROM variations WHERE tenant_id=$1 AND product_id=$2 AND NOT (id=ANY($3::uuid[]))',
        [tenant, product.id, [...kept]]);
}
