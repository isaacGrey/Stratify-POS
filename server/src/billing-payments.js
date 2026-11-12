import { createHash, randomBytes } from 'node:crypto';
import jpeg from 'jpeg-js';
import png from 'pngjs';
import { one } from './db.js';

export const receiptLimit = 5 * 1024 * 1024;
const pixelLimit = 8_000_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function paymentReference(value) {
    const reference = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9-]{3,79}$/.test(reference)) {
        throw fail(400, 'Enter a transaction reference of 4–80 letters, digits or hyphens');
    }
    return reference;
}

export function sanitizeReceipt(contents, type) {
    if (!Buffer.isBuffer(contents) || !contents.length) throw fail(400, 'Choose a PNG or JPEG receipt');
    if (contents.length > receiptLimit) throw fail(413, 'Receipt exceeds the 5 MB upload limit');
    try {
        let sanitized;
        if (type === 'image/png') {
            if (contents.length < 33 || !contents.subarray(0, 8).equals(pngSignature) ||
                contents.readUInt32BE(8) !== 13 || contents.toString('ascii', 12, 16) !== 'IHDR') throw Error();
            const width = contents.readUInt32BE(16);
            const height = contents.readUInt32BE(20);
            // Restrict decoded output and reject Adam7 streams before synchronous inflation.
            if (!width || !height || width * height > pixelLimit || contents[28] !== 0) throw Error();
            const decoded = png.PNG.sync.read(contents, { checkCRC: true });
            sanitized = png.PNG.sync.write(decoded);
        } else if (type === 'image/jpeg') {
            if (contents[0] !== 0xff || contents[1] !== 0xd8) throw Error();
            const decoded = jpeg.decode(contents, { useTArray: true, tolerantDecoding: false,
                maxResolutionInMP: pixelLimit / 1_000_000, maxMemoryUsageInMB: 80 });
            sanitized = jpeg.encode(decoded, 92).data;
        } else {
            throw fail(415, 'Use a PNG or JPEG receipt');
        }
        if (sanitized.length > receiptLimit) throw fail(413, 'Receipt image is too large after processing');
        return { mime: type, contents: sanitized, hash: createHash('sha256').update(contents).digest('hex') };
    } catch (error) {
        if (error.status) throw error;
        throw fail(400, 'Invalid receipt image. Use a PNG or JPEG up to 8 megapixels');
    }
}

export async function customerMethod(db, method) {
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(method)) throw fail(400, 'Invalid payment method');
    const result = await one(db, `
        SELECT id,name,instructions FROM subscription_payment_methods WHERE id=$1 AND customer_enabled
    `, [method]);
    if (!result) throw fail(409, 'This payment method is unavailable. Select another method.');
    return result;
}

export async function createCustomerPayment(db, tenant, plan, method, recordedBy = null) {
    return one(db, `
        INSERT INTO subscription_payments (tenant_id,plan_id,amount_cents,method,reference_no,
            evidence_required,instructions_snapshot,recorded_by_user_id,subscription_promotion_id)
        VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8)
        RETURNING id,plan_id,amount_cents,method,reference_no,status,evidence_required,submitted_at,
            submitted_reference,review_note,instructions_snapshot
    `, [tenant, plan.id, plan.price_cents, method.id, 'STRAT-' + randomBytes(10).toString('hex').toUpperCase(),
        method.instructions, recordedBy, plan.promotion_id ?? null]);
}

export async function claimReference(db, payment, reference) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 30214))', [payment.method + ':' + reference]);
    const duplicate = await one(db, `
        SELECT id FROM subscription_payments
        WHERE id<>$1 AND method=$2 AND (
            verified_reference=$3 OR
            (submitted_reference=$3 AND status IN ('pending','paid')) OR
            (method='gcash' AND status='paid' AND upper(trim(gcash_reference_no))=$3)
        ) LIMIT 1
    `, [payment.id, payment.method, reference]);
    if (duplicate) throw fail(409, 'This transaction reference is already in use');
}

export function paymentStage(payment) {
    if (payment.status !== 'pending') return payment.status;
    return payment.evidence_required && !payment.submitted_at ? 'awaiting_receipt' : 'under_review';
}

export async function submitReceipt(pool, { id, userId, tenant, reference, receipt }) {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const payment = await one(db, `
            SELECT p.id,p.tenant_id,p.method,p.status,p.evidence_required,p.submitted_reference,p.submitted_at,r.source_hash
            FROM subscription_payments p JOIN tenants t ON t.id=p.tenant_id
            JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=$2 AND m.role='owner' AND m.active
            JOIN users u ON u.id=m.user_id AND u.active
            LEFT JOIN subscription_payment_receipts r ON r.payment_id=p.id
            WHERE p.id=$1 AND p.tenant_id=$3 AND t.archived_at IS NULL
            FOR UPDATE OF p
        `, [id, userId, tenant]);
        if (!payment) throw fail(404, 'Payment request unavailable');
        if (payment.submitted_reference === reference && payment.source_hash === receipt.hash) {
            await db.query('COMMIT');
            return { status: payment.status, stage: paymentStage(payment), submitted_at: payment.submitted_at };
        }
        if (payment.status !== 'pending' || payment.submitted_at || !payment.evidence_required) {
            throw fail(409, 'This payment request cannot accept a new receipt');
        }
        await claimReference(db, payment, reference);
        await db.query(`
            INSERT INTO subscription_payment_receipts (payment_id,uploaded_by,mime_type,source_hash,contents)
            VALUES ($1,$2,$3,$4,$5)
        `, [id, userId, receipt.mime, receipt.hash, receipt.contents]);
        const submitted = await one(db, `
            UPDATE subscription_payments SET submitted_reference=$2,submitted_at=now() WHERE id=$1 RETURNING submitted_at
        `, [id, reference]);
        await db.query(`
            INSERT INTO audit_logs (tenant_id,user_id,action,details)
            VALUES ($1,$2,'subscription.receipt_submitted',jsonb_build_object('payment',$3::uuid))
        `, [tenant, userId, id]);
        await db.query('COMMIT');
        return { status: 'pending', stage: 'under_review', submitted_at: submitted.submitted_at };
    } catch (error) {
        await db.query('ROLLBACK');
        if (error.code === '23505') throw fail(409, 'This transaction reference is already in use');
        throw error;
    } finally {
        db.release();
    }
}
