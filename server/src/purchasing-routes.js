import { createHash } from 'node:crypto';
import { one, rows } from './db.js';
import { changeStock, inventoryQuantity, recordMovement } from './inventory.js';

export function registerPurchasingRoutes(app, { data, permit, need, fail, audit, ident, money, stockMode }) {
    const managers = permit('owner','manager');

    function purchaseLineInput(input) {
        need(input && ident(input.ingredient_id) && money(input.unit_cost_cents),
            'Invalid stock item or purchase price');
        const quantity = inventoryQuantity(input.quantity);
        need(quantity > 0, 'Purchase quantity must be positive');
        return { ingredient_id:input.ingredient_id, quantity, unit_cost_cents:input.unit_cost_cents };
    }

    app.get('/api/shop/purchases', managers, data((db,req) => {
        const branch = req.query.branch_id || null;
        need(!branch || ident(branch), 'Invalid branch');
        return rows(db,
            'SELECT p.*, s.name AS supplier, b.name AS branch, ' +
            '(SELECT COALESCE(sum(l.ordered_quantity*l.unit_cost_cents),0) FROM purchase_order_lines l ' +
            'WHERE l.tenant_id=p.tenant_id AND l.purchase_order_id=p.id) AS total_cost_cents ' +
            'FROM purchase_orders p JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id ' +
            'JOIN branches b ON b.tenant_id=p.tenant_id AND b.id=p.branch_id ' +
            'WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) ' +
            'ORDER BY p.created_at DESC,p.id DESC LIMIT 150',
            [req.tenant,branch]);
    }));

    app.post('/api/shop/purchases', managers, data(async (db,req) => {
        const { branch_id, supplier_id, reference='', notes='', lines } = req.body;
        need(ident(branch_id) && ident(supplier_id) &&
            typeof reference === 'string' && reference.length <= 100 &&
            typeof notes === 'string' && notes.length <= 1000 &&
            Array.isArray(lines) && lines.length > 0 && lines.length <= 100,
            'Invalid purchase order');
        const parsed = lines.map(purchaseLineInput);
        need(new Set(parsed.map(x=>x.ingredient_id)).size === parsed.length,
            'Duplicate stock items are not allowed');
        const [branch,supplier] = await Promise.all([
            one(db,'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',[req.tenant,branch_id]),
            one(db,'SELECT id FROM suppliers WHERE tenant_id=$1 AND id=$2',[req.tenant,supplier_id])
        ]);
        if (!branch || !supplier) throw fail(404,'Branch or supplier unavailable');
        for (const line of parsed) {
            const item = await one(db,'SELECT id FROM ingredients WHERE tenant_id=$1 AND id=$2',
                [req.tenant,line.ingredient_id]);
            if (!item) throw fail(404,'Purchase stock item unavailable');
        }
        const po = await one(db,
            'INSERT INTO purchase_orders(tenant_id,branch_id,supplier_id,created_by,reference,notes) ' +
            'VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [req.tenant,branch_id,supplier_id,req.user.id,reference.trim(),notes.trim()]);
        for (const line of parsed) {
            await db.query(
                'INSERT INTO purchase_order_lines(tenant_id,purchase_order_id,ingredient_id,ordered_quantity,unit_cost_cents) ' +
                'VALUES ($1,$2,$3,$4,$5)',
                [req.tenant,po.id,line.ingredient_id,line.quantity,line.unit_cost_cents]);
        }
        await audit(db,req,'purchasing.created',{id:po.id,supplier_id,branch_id,lines:parsed.length});
        return { ...po, lines:await rows(db,
            'SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND purchase_order_id=$2',
            [req.tenant,po.id]) };
    }));

    app.get('/api/shop/purchases/:id', managers, data(async (db,req) => {
        need(ident(req.params.id),'Invalid purchase order');
        const po = await one(db,
            'SELECT p.*,s.name AS supplier,b.name AS branch FROM purchase_orders p ' +
            'JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id ' +
            'JOIN branches b ON b.tenant_id=p.tenant_id AND b.id=p.branch_id ' +
            'WHERE p.tenant_id=$1 AND p.id=$2',[req.tenant,req.params.id]);
        if (!po) throw fail(404,'Purchase order unavailable');
        const lines = await rows(db,
            'SELECT l.*,i.name,i.unit FROM purchase_order_lines l ' +
            'JOIN ingredients i ON i.tenant_id=l.tenant_id AND i.id=l.ingredient_id ' +
            'WHERE l.tenant_id=$1 AND l.purchase_order_id=$2 ORDER BY i.name,l.id',
            [req.tenant,po.id]);
        const receipts = await rows(db,
            'SELECT id,request_id,received_at,actor_id FROM purchase_receipts ' +
            'WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY received_at DESC LIMIT 50',
            [req.tenant,po.id]);
        return { ...po,lines,receipts };
    }));

    app.post('/api/shop/purchases/:id/receive', managers, data(async (db,req) => {
        const { request_id, lines } = req.body;
        need(ident(req.params.id) && ident(request_id) && Array.isArray(lines) &&
            lines.length>0 && lines.length<=100,'Invalid receiving request');
        const parsed = lines.map(row => {
            need(row && ident(row.line_id),'Invalid receiving line');
            const quantity = inventoryQuantity(row.quantity);
            need(quantity>0,'Received quantity must be positive');
            return { line_id:row.line_id,quantity };
        }).sort((a,b)=>a.line_id.localeCompare(b.line_id));
        need(new Set(parsed.map(x=>x.line_id)).size===parsed.length,'Duplicate receiving lines');
        const fingerprint = createHash('sha256').update(
            JSON.stringify({order:req.params.id,lines:parsed})
        ).digest('hex');
        const po = await one(db,
            'SELECT * FROM purchase_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [req.tenant,req.params.id]);
        if (!po) throw fail(404,'Purchase order unavailable');
        const previous = await one(db,
            'SELECT * FROM purchase_receipts WHERE tenant_id=$1 AND request_id=$2',
            [req.tenant,request_id]);
        if (previous) {
            if (previous.purchase_order_id!==po.id || previous.request_fingerprint!==fingerprint) {
                throw fail(409,'Receiving request ID was used for another payload');
            }
            return { ...previous, duplicate:true };
        }
        if (po.status==='cancelled' || po.status==='received') {
            throw fail(409,'This purchase order cannot receive more stock');
        }
        const branchMode = await stockMode(db,req.tenant);
        if (!branchMode && req.branchIds!==null) {
            throw fail(403,'Workspace-wide inventory access required while shared stock is enabled');
        }
        const savedLines = await rows(db,
            'SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND purchase_order_id=$2 FOR UPDATE',
            [req.tenant,po.id]);
        const byId = new Map(savedLines.map(line=>[line.id,line]));
        const arrivals = parsed.map(line => {
            const saved=byId.get(line.line_id);
            if (!saved) throw fail(400,'Stock item does not belong to this purchase order');
            const expected=Math.round(Number(saved.ordered_quantity)*1000);
            const received=Math.round(Number(saved.received_quantity)*1000);
            const arriving=Math.round(line.quantity*1000);
            if (received+arriving>expected) throw fail(409,'Receiving quantity exceeds outstanding quantity');
            return { ...line,ingredient_id:saved.ingredient_id,unit_cost_cents:saved.unit_cost_cents };
        }).sort((a,b)=>a.ingredient_id.localeCompare(b.ingredient_id));

        const receipt = await one(db,
            'INSERT INTO purchase_receipts(tenant_id,purchase_order_id,branch_id,request_id,request_fingerprint,actor_id) ' +
            'VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [req.tenant,po.id,po.branch_id,request_id,fingerprint,req.user.id]);
        for (const line of arrivals) {
            await changeStock(db,req.tenant,line.ingredient_id,
                branchMode ? po.branch_id : null,line.quantity,branchMode);
            await db.query(
                'UPDATE purchase_order_lines SET received_quantity=received_quantity+$3 ' +
                'WHERE tenant_id=$1 AND id=$2',
                [req.tenant,line.line_id,line.quantity]);
            await db.query(
                'UPDATE ingredients SET unit_cost_cents=$3 WHERE tenant_id=$1 AND id=$2',
                [req.tenant,line.ingredient_id,line.unit_cost_cents]);
            await db.query(
                'INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,purchase_order_line_id,quantity,unit_cost_cents) ' +
                'VALUES($1,$2,$3,$4,$5)',
                [req.tenant,receipt.id,line.line_id,line.quantity,line.unit_cost_cents]);
            await recordMovement(db,req.tenant,line.ingredient_id,branchMode ? po.branch_id : null,line.quantity,
                'stock_in','Purchase order '+po.id,req.user.id,receipt.id);
        }
        const completion = await one(db,
            'SELECT bool_and(received_quantity=ordered_quantity) AS complete ' +
            'FROM purchase_order_lines WHERE tenant_id=$1 AND purchase_order_id=$2',
            [req.tenant,po.id]);
        const status = completion.complete ? 'received' : 'partially_received';
        await db.query('UPDATE purchase_orders SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
            [req.tenant,po.id,status]);
        await audit(db,req,'purchasing.received',{order_id:po.id,receipt_id:receipt.id,lines:arrivals.length});
        return { ...receipt,status };
    }));

    app.post('/api/shop/purchases/:id/cancel', managers, data(async (db,req) => {
        need(ident(req.params.id),'Invalid purchase order');
        const po=await one(db,
            'SELECT * FROM purchase_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [req.tenant,req.params.id]);
        if (!po) throw fail(404,'Purchase order unavailable');
        if (po.status!=='submitted') throw fail(409,'Only unreceived purchase orders can be cancelled');
        const result=await one(db,
            "UPDATE purchase_orders SET status='cancelled',updated_at=now() " +
            'WHERE tenant_id=$1 AND id=$2 RETURNING *',[req.tenant,po.id]);
        await audit(db,req,'purchasing.cancelled',{id:po.id});
        return result;
    }));
}
