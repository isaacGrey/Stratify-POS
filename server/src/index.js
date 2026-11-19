
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import 'dotenv/config';
import { issueSignedOfflineGrant, verifyOfflineSaleGrant } from './offline-grants.js';

import { claimReference, createCustomerPayment, customerMethod, paymentReference, paymentStage, receiptLimit, sanitizeReceipt, submitReceipt } from './billing-payments.js';

import { canUseRoute, moduleAccess, validPermissions } from './workspace-access.js';
import { platformRouter } from './admin-platform.js';
import { backupRouter } from './backup-routes.js';
import { inTransaction, planId, platformAudit, priceSubscription, provisionBusiness } from './platform.js';
import { pool, scoped, rows, one } from './db.js';
import { listProducts, saveVariations, replaceRecipe, productOptions, catalogConflict } from './catalog-options.js';
import { changeStock, inventoryQuantity, listBalances, recordMovement, transferStock } from './inventory.js';
import { registerRegisterRoutes } from './register-routes.js';
import { registerPurchasingRoutes } from './purchasing-routes.js';
import { registerRefundRoutes } from './refund-routes.js';
import { registerHoldRoutes } from './holds-routes.js';
import { registerCustomerMenuRoutes } from './customer-menu-routes.js';
import { registerKitchenRoutes, enqueueKitchenTicket } from './kitchen-routes.js';
import { registerServiceRoutes } from './service-routes.js';
import {registerAppointmentRoutes} from './appointment-routes.js';
import {registerOperationsReports} from './operations-reports.js';
import {validateMembershipCart,fulfillMembershipCheckout} from './pos-memberships.js';
import { loadReport, reportFilters } from './reports.js';
import { attendanceHistory, attendanceStatus, attendanceSummary, recordAttendance } from './attendance.js';
import { branchSchedule, saveBranchSchedule } from './branch-operations.js';
import { offlineEligible, orderPromotion, recordLoyalty, savePromotion, validLoyaltyCode } from './promotions.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet());

const allowedOrigins = (
    process.env.CLIENT_URL ||
    'http://localhost:5173,http://localhost:4173'
)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const appClientUrl = (process.env.APP_PUBLIC_URL || allowedOrigins[0] || '').replace(/\/$/,'');

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(
            new Error('CORS origin not allowed')
        );
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Tenant-Id',
        'X-Payment-Reference'
    ]
}));

app.use(express.json({ limit: '100kb' }));

const secret = process.env.JWT_SECRET;

if (!secret || secret.length < 32) {
    throw Error('JWT_SECRET must be 32+ characters');
}


const wrap = (f) => (req, res, next) => {
    Promise.resolve()
        .then(() => f(req, res, next))
        .catch(next);
};

const fail = (status, msg) =>
    Object.assign(new Error(msg), { status });

const need = (condition, msg = 'Invalid request') => {
    if (!condition) throw fail(400, msg);
};

const email = e => String(e || '').trim().toLowerCase();

const money = n =>
    Number.isInteger(n) && n >= 0 && n <= 100000000;

const ident = x =>
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(x || ''));

const hashToken = t =>
    crypto.createHash('sha256').update(t).digest('hex');

const newToken = () => crypto.randomBytes(32).toString('hex');

const sign = u => jwt.sign(
    { sub: u.id },
    secret,
    { expiresIn: '8h', issuer: 'coffee-saas' }
);

// AUTHENTICATION

const auth = wrap(async (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer /i, '');

    if (!token) throw fail(401, 'Authentication required');

    let payload;

    try {
        payload = jwt.verify(token, secret, {
            issuer: 'coffee-saas'
        });
    } catch {
        throw fail(401, 'Session expired');
    }

    req.user = await one(
        pool,
        'SELECT id,name,email,active,platform_admin FROM users WHERE id=$1',
        [payload.sub]
    );

    if (!req.user?.active) {
        throw fail(401, 'Account unavailable');
    }

    next();
});

const isPlatformAdmin = user => user.platform_admin && user.email === email(process.env.SUPERADMIN_EMAIL);

const admin = (req, res, next) => {
    if (!isPlatformAdmin(req.user)) {
        return next(fail(403, 'Super admin only'));
    }
    next();
};


// ======================================================
// STRATIFYPOS — TENANT ACCESS CONTROL
// Check membership, business status and subscription.
// ======================================================

const tenant = wrap(async (req, res, next) => {
    const tenantId = req.headers['x-tenant-id'];

    if (!ident(tenantId)) {
        throw fail(400, 'Select a business first');
    }

    const access = await one(
        pool,
        `
        SELECT
            t.id,
            t.name,
            t.status,
            m.role,
            s.plan_id,
            s.status AS subscription_status,
            s.trial_ends_at,
            s.current_period_ends_at, m.module_permissions, m.branch_ids, t.business_type,ks.kitchen_enabled, t.module_overrides, p.module_access, wr.permissions AS role_permissions

        FROM tenants t

        JOIN memberships m
          ON m.tenant_id = t.id

        JOIN subscriptions s
          ON s.tenant_id = t.id
        JOIN plans p ON p.id=s.plan_id
        LEFT JOIN workspace_role_permissions wr ON wr.tenant_id=t.id AND wr.role=m.role
        LEFT JOIN shop_settings ks ON ks.tenant_id=t.id

        WHERE t.id = $1
          AND m.user_id = $2
          AND m.active = TRUE
          AND t.status = 'active' AND NOT t.administratively_suspended
          AND t.archived_at IS NULL
        `,
        [
            tenantId,
            req.user.id
        ]
    );

    if (!access) {
        throw fail(
            403,
            'Business unavailable or access denied'
        );
    }

    const now = Date.now();

    const trialValid =
        access.plan_id === 'free' &&
        access.subscription_status === 'trial' &&
        access.trial_ends_at &&
        new Date(access.trial_ends_at).getTime() > now;

    const paidValid =
        access.plan_id !== 'free' &&
        access.subscription_status === 'active' &&
        access.current_period_ends_at &&
        new Date(access.current_period_ends_at).getTime() > now;

    if (!trialValid && !paidValid) {
        throw fail(
            403,
            'Subscription expired or payment pending. Please renew your plan.'
        );
    }

    req.tenant = tenantId;
    req.role = access.role;
    req.modules = moduleAccess(access);
    req.modules.kitchen = req.modules.kitchen && access.business_type==='food' && access.kitchen_enabled===true;
    req.branchIds = access.branch_ids ?? null;

    next();
});

const enforceModule = (req, _res, next) => {
    const path = req.path.replace(/^\/api\/shop(?=\/)/, '');
    if (!canUseRoute(path, req.method, req.modules, req.branchIds)) {
        return next(fail(403, 'This module is unavailable for your workspace access'));
    }
    next();
};

const scopeOptions = req => ({ branchIds: req.branchIds, userId: req.user.id });

const permit = (...roles) => (req, res, next) =>
    roles.includes(req.role)
        ? next()
        : next(fail(403, 'Insufficient permissions'));

const data = f => wrap(async (req, res) => {
    const result = await scoped(
        req.tenant,
        d => f(d, req),
        scopeOptions(req)
    );
    res.json(result);
});

const audit = (db, req, action, details = {}) =>
    db.query(
        `INSERT INTO audit_logs
         (tenant_id,user_id,action,details)
         VALUES($1,$2,$3,$4)`,
        [req.tenant, req.user.id, action, details]
    );

// EMAIL SERVICE

async function sendMail(to, subject, body) {
    if (!process.env.SMTP_HOST) {
        console.warn('SMTP not configured; email not sent to', to);
        return false;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject,
        text: body
    });

    return true;
}

const publicLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

app.use('/api', wrap(async (req, _res, next) => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(req.method) && /^\/(shop|billing|auth)(\/|$)/.test(req.path) &&
        !['/auth/login','/billing/payment-status','/shop/checkout/quote'].includes(req.path)) {
        const platform = await one(pool,'SELECT maintenance_mode FROM platform_settings WHERE singleton');
        if (platform?.maintenance_mode) throw fail(503,'StratifyPOS is in recovery maintenance. Try again when it is complete.');
    }
    next();
}));

// PUBLIC ROUTES

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/ready', wrap(async (_req, res) => {
    try {
        await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
        res.json({ ok: true });
    } catch {
        res.status(503).json({ ok: false });
    }
}));

app.get('/api/public/site', wrap(async (_req,res) => {
    const settings = await one(pool,'SELECT public_name,support_email FROM platform_settings WHERE singleton');
    res.json(settings);
}));

const inquiryLimit = rateLimit({ windowMs:60*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false });
app.post('/api/public/inquiries', inquiryLimit, wrap(async (req,res) => {
    const { name, business = '', message, website = '' } = req.body;
    const address = email(req.body.email);
    need(typeof name==='string' && name.trim().length>0 && name.trim().length<=120 &&
        typeof business==='string' && business.trim().length<=120 &&
        typeof message==='string' && message.trim().length>=10 && message.trim().length<=4000 &&
        /^\S+@\S+\.\S+$/.test(address) && address.length<=254 && website==='', 'Enter valid contact details and a message');
    await pool.query('INSERT INTO public_inquiries (name,email,business,message) VALUES ($1,$2,$3,$4)',
        [name.trim(),address,business.trim(),message.trim()]);
    res.status(201).json({ received:true });
}));

app.get('/api/plans', wrap(async (_req,res) => {
    const plans = await rows(pool,
        "SELECT * FROM plans WHERE active AND (id<>'free' OR trial_days>0) ORDER BY price_cents,id");
    res.json(await Promise.all(plans.map(async plan => {
        if (plan.price_cents === 0) return plan;
        const quote = await priceSubscription(pool, plan);
        return { ...plan, promotional_price_cents: quote.promotion_id ? quote.price_cents : null,
            promotion_name: quote.promotion_name ?? null };
    })));
}));


// ======================================================
// STRATIFYPOS — BUSINESS REGISTRATION
// Free: configurable trial
// Basic / Premium: monthly, pending payment verification
// ======================================================

app.post(
    '/api/auth/register',
    publicLimit,
    wrap(async (req, res) => {
        const {
            name,
            password,
            shopName,
            plan = 'free',
            business_type = 'food',
            skip_trial = false
        } = req.body;

        const userEmail = email(req.body.email);
        need(userEmail !== email(process.env.SUPERADMIN_EMAIL), 'Email unavailable');

        need(
            typeof name === 'string' &&
            name.trim().length > 0 &&
            typeof shopName === 'string' &&
            shopName.trim().length > 0 &&
            /^\S+@\S+\.\S+$/.test(userEmail) &&
            typeof password === 'string' &&
            password.length >= 12,
            'Business name, owner name, valid email and 12+ character password required'
        );

        need(
            planId(plan) && typeof skip_trial==='boolean' && ['food','non_food'].includes(business_type),
            'Invalid subscription plan'
        );

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // --------------------------------------------------
            // 1. Load the selected plan from the database.
            // --------------------------------------------------

            const selectedPlan = await one(
                client,
                `
                SELECT
                    id,
                    title,
                    price_cents,
                    trial_days,
                    max_branches,
                    max_staff
                FROM plans
                WHERE id = $1
                  AND active = TRUE
                `,
                [plan]
            );

            if (!selectedPlan) {
                throw fail(400, 'Subscription plan unavailable');
            }

            const trialPlan = skip_trial ? null : await one(client,
                "SELECT id,trial_days FROM plans WHERE id='free' AND active AND trial_days>0");
            const isFreeTrial = Boolean(trialPlan);
            if (!isFreeTrial && selectedPlan.price_cents <= 0) throw fail(400,'Select an available paid plan');

            // --------------------------------------------------
            // 2. Create owner account.
            // --------------------------------------------------

            const passwordHash = await bcrypt.hash(
                password,
                12
            );

            const user = await one(
                client,
                `
                INSERT INTO users (
                    name,
                    email,
                    password_hash
                )
                VALUES ($1, $2, $3)
                RETURNING id, name, email
                `,
                [
                    name.trim(),
                    userEmail,
                    passwordHash
                ]
            );

            const { business, subscription } = await provisionBusiness(client, {
                ownerId: user.id, name: shopName, plan: trialPlan || selectedPlan, status: isFreeTrial ? 'trial' : 'expired', businessType:business_type
            });

            await client.query('COMMIT');

            // --------------------------------------------------
            // 7. Registration response.
            // --------------------------------------------------

            if (isFreeTrial) {
                return res.status(201).json({
                    token: sign(user),
                    user,
                    shop: business,
                    subscription,
                    message:
                        'Your free trial has started.'
                });
            }

            // Never issue a workspace JWT for
            // an unverified paid registration.
            return res.status(201).json({
                status: 'payment_pending',
                plan: selectedPlan.id,
                amount_cents: selectedPlan.price_cents,
                message:
                    'Business registered. Monthly payment verification is required before activation.'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.code === '23505') {
                throw fail(
                    409,
                    'Email already registered. Please sign in instead.'
                );
            }

            throw error;

        } finally {
            client.release();
        }
    })
);



app.post(
    '/api/auth/login',
    publicLimit,
    wrap(async (req, res) => {
        const user = await one(
            pool,
            `
            SELECT *
            FROM users
            WHERE email = $1
              AND active = TRUE
            `,
            [email(req.body.email)]
        );

        if (
            !user ||
            !await bcrypt.compare(
                String(req.body.password || ''),
                user.password_hash
            )
        ) {
            throw fail(
                401,
                'Invalid email or password'
            );
        }

        const isSuperAdmin =
            Boolean(isPlatformAdmin(user));

        if (!isSuperAdmin) {
            const allowed = await one(
                pool,
                `
                SELECT EXISTS (
                    SELECT 1

                    FROM memberships m

                    JOIN tenants t
                      ON t.id = m.tenant_id

                    JOIN subscriptions s
                      ON s.tenant_id = t.id

                    WHERE m.user_id = $1
                      AND m.active = TRUE
                      AND t.status = 'active'
                      AND t.archived_at IS NULL

                      AND (
                          (
                              s.plan_id = 'free'
                              AND s.status = 'trial'
                              AND s.trial_ends_at > NOW()
                          )
                          OR
                          (
                              s.plan_id <> 'free'
                              AND s.status = 'active'
                              AND s.current_period_ends_at > NOW()
                          )
                      )
                ) AS permitted
                `,
                [user.id]
            );

            if (!allowed?.permitted) {
                throw fail(
                    403,
                    'No active subscription. Your trial may have expired or your monthly payment is pending.'
                );
            }
        }

        res.json({
            token: sign(user),
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });
    })
);



// ============================================================
// STRATIFYPOS - BILLING AND SUBSCRIPTION RENEWAL
// Supports expired trials and pending paid registrations.
// GCash payment confirmation is MANUAL for now.
// ============================================================

async function verifyBillingOwner(emailAddress, password) {
    const account = await one(
        pool,
        `
        SELECT
            id,
            email,
            password_hash,
            active
        FROM users
        WHERE email = $1
        `,
        [email(emailAddress)]
    );

    if (
        !account ||
        !account.active ||
        !await bcrypt.compare(
            String(password || ''),
            account.password_hash
        )
    ) {
        throw fail(401, 'Invalid email or password');
    }

    if (
        email(account.email) ===
        email(process.env.SUPERADMIN_EMAIL)
    ) {
        throw fail(403, 'Invalid billing account');
    }

    return account;
}


const publicEvidenceToken = (account, payment) => jwt.sign(
    { sub: account.id, payment: payment.id, tenant: payment.tenant_id },
    secret, { issuer: 'stratifypos-payment-evidence', expiresIn: '30m' }
);

const receiptParser = express.raw({ type: () => true, limit: receiptLimit, inflate: false });
const receiptLimitByIp = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });

app.get('/api/billing/methods', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await rows(pool,
        'SELECT id,name FROM subscription_payment_methods WHERE customer_enabled ORDER BY name,id'));
}));

app.post('/api/billing/select-plan', publicLimit, wrap(async (req, res) => {
    const { plan_id, method = 'gcash', discount_code } = req.body;
    need(planId(plan_id), 'Select a paid plan');
    const account = await verifyBillingOwner(req.body.email, req.body.password);
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const business = await one(db, `
            SELECT t.id,t.name
            FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN subscriptions s ON s.tenant_id=t.id
            WHERE m.user_id=$1 AND m.role='owner' AND m.active AND t.archived_at IS NULL
                AND NOT t.administratively_suspended
                AND NOT (t.status='active' AND (
                    (s.status='trial' AND s.trial_ends_at>now()) OR
                    (s.status='active' AND s.current_period_ends_at>now())
                ) IS TRUE)
            ORDER BY t.created_at DESC LIMIT 1 FOR UPDATE OF t,s
        `, [account.id]);
        if (!business) throw fail(409, 'No expired or pending business subscription found');
        let payment = await one(db, `
            SELECT id,plan_id,amount_cents,method,reference_no,status,evidence_required,submitted_at,
                submitted_reference,review_note,instructions_snapshot
            FROM subscription_payments
            WHERE tenant_id=$1 AND status='pending' AND evidence_required AND submitted_at IS NOT NULL
            ORDER BY submitted_at DESC LIMIT 1
        `, [business.id]);
        if (!payment) {
            const option = await customerMethod(db, method);
            const plan = await one(db, 'SELECT id,price_cents FROM plans WHERE id=$1 AND active AND price_cents>0', [plan_id]);
            if (!plan) throw fail(400, 'Selected subscription plan unavailable');
            const quote = await priceSubscription(db, plan, discount_code);
            payment = await one(db, `
                SELECT id,plan_id,amount_cents,method,reference_no,status,evidence_required,submitted_at,
                    submitted_reference,review_note,instructions_snapshot
                FROM subscription_payments WHERE tenant_id=$1 AND status='pending'
                    AND plan_id=$2 AND method=$3 AND amount_cents=$4 AND subscription_promotion_id IS NOT DISTINCT FROM $5::uuid
                ORDER BY created_at DESC LIMIT 1 FOR UPDATE
            `, [business.id, plan.id, option.id, quote.price_cents, quote.promotion_id]);
            if (payment && !payment.evidence_required) {
                await db.query('UPDATE subscription_payments SET evidence_required=true,instructions_snapshot=$2 WHERE id=$1',
                    [payment.id, option.instructions]);
                payment = { ...payment, evidence_required: true, instructions_snapshot: option.instructions };
            }
            if (!payment) payment = await createCustomerPayment(db, business.id, quote, option);
        }
        const labels = await one(db, `
            SELECT p.title AS plan_title,m.name AS method_name FROM plans p
            CROSS JOIN subscription_payment_methods m WHERE p.id=$1 AND m.id=$2
        `, [payment.plan_id,payment.method]);
        const lastRejection = await one(db, `
            SELECT review_note FROM subscription_payments WHERE tenant_id=$1 AND status='failed'
            AND reviewed_at IS NOT NULL AND reviewed_at >= now() - interval '30 days'
            ORDER BY reviewed_at DESC LIMIT 1
        `, [business.id]);
        await db.query('COMMIT');
        res.set('Cache-Control','no-store').json({ status: 'payment_pending', business,
            payment: { ...payment, ...labels, stage: paymentStage(payment) },
            recent_rejection: lastRejection?.review_note || null,
            evidence_token: publicEvidenceToken(account, { id: payment.id, tenant_id: business.id })
        });
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }
}));

function evidenceAccess(req, _res, next) {
    try {
        const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
        const claims = jwt.verify(token, secret, { issuer: 'stratifypos-payment-evidence', algorithms: ['HS256'] });
        if (!ident(claims.sub) || !ident(claims.tenant) || claims.payment !== req.params.id) throw Error();
        req.evidenceAccess = { userId: claims.sub, tenant: claims.tenant };
        next();
    } catch {
        next(fail(401, 'Payment upload access expired. Check payment status to renew access.'));
    }
}

async function receivePaymentEvidence(req, res) {
    need(ident(req.params.id), 'Invalid payment ID');
    const reference = paymentReference(req.get('X-Payment-Reference'));
    const type = req.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const receipt = sanitizeReceipt(req.body, type);
    const actor = req.evidenceAccess ?? { userId: req.user.id, tenant: req.tenant };
    const result = await submitReceipt(pool, { ...actor, id: req.params.id, reference, receipt });
    res.set('Cache-Control','no-store').json(result);
}

app.post('/api/billing/payments/:id/evidence', receiptLimitByIp, evidenceAccess, receiptParser, wrap(receivePaymentEvidence));

app.post(
    '/api/billing/payment-status',
    publicLimit,
    wrap(async (req, res) => {
        need(
            ident(req.body.payment_id),
            'Invalid payment ID'
        );

        const account = await verifyBillingOwner(
            req.body.email,
            req.body.password
        );

        // Payment belongs to a business this user owns.
        const payment = await one(
            pool,
            `
            SELECT
                sp.id,
                sp.status,
                sp.plan_id,
                sp.amount_cents,
                sp.reference_no,
                sp.method, sp.evidence_required, sp.submitted_at, sp.submitted_reference,
                sp.review_note, sp.paid_at, sp.verified_reference,

                t.id AS business_id,
                t.name AS business_name,

                s.status AS subscription_status,
                s.current_period_ends_at

            FROM subscription_payments sp

            JOIN tenants t
                ON t.id = sp.tenant_id

            JOIN memberships m
                ON m.tenant_id = t.id

            JOIN subscriptions s
                ON s.tenant_id = t.id

            WHERE sp.id = $1
              AND m.user_id = $2
              AND m.role = 'owner'
              AND m.active = TRUE
              AND t.archived_at IS NULL
            `,
            [
                req.body.payment_id,
                account.id
            ]
        );

        if (!payment) {
            throw fail(
                404,
                'Payment request not found'
            );
        }

        const activated =
            payment.status === 'paid' &&
            payment.subscription_status === 'active' &&
            payment.current_period_ends_at &&
            new Date(
                payment.current_period_ends_at
            ).getTime() > Date.now();

        res.set('Cache-Control','no-store').json({
            payment: { ...payment, stage: paymentStage(payment) },
            evidence_token: publicEvidenceToken(account, { id: payment.id, tenant_id: payment.business_id }),
            activated: Boolean(activated)
        });
    })
);

// FORGOT PASSWORD

app.post('/api/auth/forgot', publicLimit, wrap(async (req, res) => {
    const u = await one(
        pool,
        'SELECT id,email FROM users WHERE email=$1',
        [email(req.body.email)]
    );

    if (u) {
        const t = newToken();

        await pool.query(
            `INSERT INTO password_tokens
             (user_id,token_hash,expires_at)
             VALUES($1,$2,NOW() + INTERVAL '30 minutes')`,
            [u.id, hashToken(t)]
        );

        await sendMail(
            u.email,
            'Reset your Coffee SaaS password',
            `${appClientUrl}/reset?token=${t}\nExpires in 30 minutes.`
        );
    }

    res.json({
        message: 'If the email exists, password reset instructions were sent.'
    });
}));

// RESET PASSWORD

app.post('/api/auth/reset', publicLimit, wrap(async (req, res) => {
    need(
        String(req.body.password || '').length >= 12,
        'Password must be 12+ characters'
    );

    const t = await one(
        pool,
        `UPDATE password_tokens
         SET used_at=now()
         WHERE token_hash=$1
           AND used_at IS NULL
           AND expires_at>now()
         RETURNING user_id`,
        [hashToken(String(req.body.token || ''))]
    );

    if (!t) throw fail(400, 'Invalid or expired token');

    await pool.query(
        'UPDATE users SET password_hash=$1 WHERE id=$2',
        [await bcrypt.hash(req.body.password, 12), t.user_id]
    );

    res.json({ message: 'Password updated' });
}));

// CURRENT USER AND AUTHORIZED SHOPS


// =============================================
// STRATIFYPOS OFFLINE ACCESS GRANT
// READ-ONLY POS RESTORATION ONLY
// =============================================

app.post(
    '/api/shop/offline/grant',
    auth,
    tenant,
    enforceModule,
    permit('owner', 'manager', 'cashier'),
    wrap(async (req, res) => {
        const { branchId, deviceId } = req.body || {};

        need(
            ident(branchId) && ident(deviceId),
            'Valid branch and device IDs are required'
        );

        const branch = await scoped(
            req.tenant,
            db => one(
                db,
                `SELECT b.id, b.name, s.tax_basis_points, s.service_basis_points, s.receipt_footer
                 FROM branches b JOIN shop_settings s ON s.tenant_id = b.tenant_id
                 WHERE b.tenant_id = $1 AND b.id = $2 AND b.active = TRUE`,
                [req.tenant, branchId]
            ),
            scopeOptions(req)
        );

        if (!branch) {
            throw fail(403, 'Branch not authorized');
        }

        const access = await one(
            pool,
            `SELECT t.name, t.status, s.plan_id,
                    s.trial_ends_at,
                    s.current_period_ends_at
             FROM tenants t
             JOIN subscriptions s ON s.tenant_id = t.id
             WHERE t.id = $1`,
            [req.tenant]
        );

        if (!access) {
            throw fail(403, 'Business unavailable');
        }

        const subscriptionExpiry =
            access.plan_id === 'free'
                ? access.trial_ends_at
                : access.current_period_ends_at;

        const issuedAt = Date.now();
        const expiryMs = Math.min(
            issuedAt + 12 * 60 * 60 * 1000,
            new Date(subscriptionExpiry).getTime()
        );

        if (
            !Number.isFinite(expiryMs) ||
            expiryMs <= Date.now()
        ) {
            throw fail(403, 'Subscription expired');
        }

        const grant = {
            version: 2,
            purpose: 'stratifypos-offline-cash',

            userId: req.user.id,
            userName: req.user.name,

            userEmail: req.user.email,

            tenantId: req.tenant,
            tenantName: access.name,

            branchId: branch.id,
            branchName: branch.name,

            deviceId,
            role: req.role,

            permissions: ['catalog:read', 'checkout:cash'],
            taxBasisPoints: branch.tax_basis_points,
            serviceBasisPoints: branch.service_basis_points,
            receiptFooter: branch.receipt_footer,
            issuedAt,
            expiresAt: expiryMs
        };

        res.set('Cache-Control', 'no-store');

        res.json({
            grant: issueSignedOfflineGrant(grant),
            expiresAt: new Date(expiryMs).toISOString()
        });
    })
);


app.get(
    '/api/me',
    auth,
    wrap(async (req, res) => {
        const shops = await rows(
            pool,
            `
            SELECT
                t.id,
                t.name,
                t.slug,
                t.status,
                m.role,
                s.plan_id,
                s.status AS subscription_status,
                s.trial_ends_at,
                s.current_period_ends_at,m.branch_ids,m.module_permissions,t.business_type,ks.kitchen_enabled,t.module_overrides,p.module_access,wr.permissions AS role_permissions

            FROM memberships m

            JOIN tenants t
              ON t.id = m.tenant_id

            JOIN subscriptions s
              ON s.tenant_id = t.id
            JOIN plans p ON p.id=s.plan_id
            LEFT JOIN shop_settings ks ON ks.tenant_id=t.id
            LEFT JOIN workspace_role_permissions wr ON wr.tenant_id=t.id AND wr.role=m.role

            WHERE m.user_id = $1
              AND m.active = TRUE
              AND t.status = 'active' AND NOT t.administratively_suspended
              AND t.archived_at IS NULL

              AND (
                  (
                      s.plan_id = 'free'
                      AND s.status = 'trial'
                      AND s.trial_ends_at > NOW()
                  )
                  OR
                  (
                      s.plan_id <> 'free'
                      AND s.status = 'active'
                      AND s.current_period_ends_at > NOW()
                  )
              )

            ORDER BY t.created_at ASC
            `,
            [req.user.id]
        );

        res.json({
            user: req.user,
            shops: shops.map(({ module_permissions, module_overrides, module_access, role_permissions, ...shop }) => ({
                ...shop, modules: { ...moduleAccess({ ...shop, module_permissions, module_overrides, module_access, role_permissions }),
                  kitchen: shop.business_type==='food' && shop.kitchen_enabled===true &&
                    moduleAccess({ ...shop,module_permissions,module_overrides,module_access,role_permissions }).kitchen }
            })),
            superAdmin:
                Boolean(isPlatformAdmin(req.user))
        });
    })
);



// ACCEPT INVITATION

app.post('/api/auth/accept-invite', publicLimit, wrap(async (req, res) => {
    const { token, name, password } = req.body;

    need(
        token && name && password?.length >= 12,
        'Token, name and 12+ character password required'
    );

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const lookup = await one(
            client,
            'SELECT public.invitation_tenant($1) tenant_id',
            [hashToken(token)]
        );

        if (!lookup?.tenant_id) throw fail(400, 'Invalid invitation');

        await client.query(
            "SELECT set_config('app.tenant_id',$1,true)",
            [lookup.tenant_id]
        );

        const inv = await one(
            client,
            `SELECT *
             FROM invites
             WHERE token_hash=$1
               AND accepted_at IS NULL
               AND expires_at>now()
             FOR UPDATE`,
            [hashToken(token)]
        );

        if (!inv || inv.email === email(process.env.SUPERADMIN_EMAIL)) throw fail(400, 'Invalid invitation');

        let u = await one(
            client,
            'SELECT id FROM users WHERE email=$1',
            [inv.email]
        );

        if (!u) {
            u = await one(
                client,
                `INSERT INTO users(name,email,password_hash)
                 VALUES($1,$2,$3)
                 RETURNING id`,
                [name, inv.email, await bcrypt.hash(password, 12)]
            );
        }

        await checkStaffCapacity(client, inv.tenant_id, u.id);
        
await client.query(
    `
    INSERT INTO memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES ($1, $2, $3)

    ON CONFLICT (tenant_id, user_id)
    DO UPDATE SET
        active = TRUE,
        role = CASE
            WHEN memberships.role = 'owner'
                THEN 'owner'
            ELSE EXCLUDED.role
        END
    `,
    [
        inv.tenant_id,
        u.id,
        inv.role
    ]
);


        await client.query(
            'UPDATE invites SET accepted_at=now() WHERE id=$1',
            [inv.id]
        );

        await client.query('COMMIT');

        res.json({
            message: 'Invitation accepted; you can log in.'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}));

// Public QR menu endpoints are intentionally outside authenticated workspace middleware.
// Every public request is constrained by a random table QR token, enabled policy and a tenant-scoped DB transaction.
// SHOP ROUTES

app.use('/api/shop', auth, tenant, enforceModule);
registerCustomerMenuRoutes(app,{wrap,data,permit,need,fail,audit,ident});
registerServiceRoutes(app,{data,permit,audit,ident});
registerAppointmentRoutes(app,{data,permit,audit,fail});
registerOperationsReports(app,{wrap,permit});

// OVERVIEW

app.get('/api/shop/overview', data(async (d, r) => {
    const [sales, low, top, recent, staff] = await Promise.all([
        one(
            d,
            `SELECT
                count(*)::int orders,
                (COALESCE(sum(total_cents),0)::bigint -
                 (SELECT COALESCE(sum(f.amount_cents),0)::bigint FROM sales_refunds f
                  WHERE f.tenant_id=$1
                    AND (f.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date)) AS revenue
             FROM orders
             WHERE tenant_id=$1
               AND status IN ('paid','partially_refunded','refunded')
               AND (created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date`,
            [r.tenant, process.env.REPORT_TIME_ZONE || 'Asia/Manila']
        ),
        one(
            d,
            `SELECT count(*)::int count
             FROM ingredients i
             WHERE i.tenant_id=$1 AND (
                 $2::boolean AND i.quantity<=i.low_stock_at OR NOT $2 AND EXISTS (
                    SELECT 1 FROM branch_stock_balances b WHERE b.tenant_id=i.tenant_id
                    AND b.ingredient_id=i.id AND b.quantity<=i.low_stock_at
                 )
             )`,
            [r.tenant,r.branchIds===null]
        ),
        rows(
            d,
            `SELECT oi.product_name name,
                    sum(oi.quantity)::int qty
             FROM order_items oi
             JOIN orders o
               ON o.id=oi.order_id
              AND o.tenant_id=oi.tenant_id
             WHERE o.tenant_id=$1 AND o.status IN ('paid','partially_refunded','refunded')
             GROUP BY oi.product_name
             ORDER BY qty DESC
             LIMIT 5`,
            [r.tenant]
        ),
        rows(
            d,
            `SELECT id,order_number,total_cents,payment_method,created_at
             FROM orders
             WHERE tenant_id=$1
             ORDER BY created_at DESC
             LIMIT 6`,
            [r.tenant]
        ),
        one(
            d,
            `SELECT count(*)::int count
             FROM memberships
             WHERE tenant_id=$1 AND active=true`,
            [r.tenant]
        )
    ]);

    return { sales, low, top, recent, staff, role: r.role };
}));

// SETTINGS

app.get('/api/shop/settings', data((d, r) =>
    one(d, 'SELECT * FROM shop_settings WHERE tenant_id=$1', [r.tenant])
));

app.put(
    '/api/shop/settings',
    permit('owner', 'manager'),
    data(async (d, r) => {
        const {
            tax_basis_points = 0,
            service_basis_points = 0,
            receipt_footer = 'Thank you!',
            loyalty_cents_per_point = null,
            kitchen_enabled = null
        } = r.body;

        need(
            [tax_basis_points, service_basis_points]
                .every(v => Number.isInteger(v) && v >= 0 && v <= 10000) &&
            (loyalty_cents_per_point === null || money(loyalty_cents_per_point) && loyalty_cents_per_point > 0) &&
            (kitchen_enabled===null || typeof kitchen_enabled==='boolean'),
            'Invalid rate'
        );

        const business=await one(d,'SELECT business_type FROM tenants WHERE id=$1',[r.tenant]);
        if(kitchen_enabled===true&&business?.business_type!=='food')throw fail(403,'Kitchen is only available for food businesses');
        return one(
            d,
            `UPDATE shop_settings
             SET tax_basis_points=$1,
                 service_basis_points=$2,
                 receipt_footer=$3, loyalty_cents_per_point=COALESCE($5, loyalty_cents_per_point),
                 kitchen_enabled=CASE WHEN $6::boolean IS NULL THEN kitchen_enabled ELSE $6 END
             WHERE tenant_id=$4
             RETURNING *`,
            [
                tax_basis_points,
                service_basis_points,
                String(receipt_footer).slice(0, 300),
                r.tenant,
                loyalty_cents_per_point,
                business?.business_type==='food'?kitchen_enabled:false
            ]
        );
    })
);

// BRANCHES

app.get('/api/shop/branches', data((d, r) =>
    rows(
        d,
        `SELECT *
         FROM branches
         WHERE tenant_id=$1
         ORDER BY created_at ASC`,
        [r.tenant]
    )
));

app.post(
    '/api/shop/branches',
    permit('owner', 'manager'),
    data(async (d, r) => {
        need(typeof r.body.name === 'string' && r.body.name.trim() && r.body.name.length <= 120, 'Valid branch name required');

        const sub = await one(
            d,
            `SELECT p.max_branches
             FROM subscriptions s
             JOIN plans p ON p.id=s.plan_id
             WHERE s.tenant_id=$1 FOR UPDATE OF s`,
            [r.tenant]
        );

        const count = await one(
            d,
            'SELECT count(*)::int n FROM branches WHERE tenant_id=$1',
            [r.tenant]
        );

        need(count.n < sub.max_branches, 'Branch limit reached for your plan');

        return one(
            d,
            `INSERT INTO branches
             (tenant_id,name,address,open_time,close_time)
             VALUES($1,$2,$3,$4,$5)
             RETURNING *`,
            [
                r.tenant,
                r.body.name.trim(),
                r.body.address || '',
                r.body.open_time || '07:00',
                r.body.close_time || '21:00'
            ]
        );
    })
);

app.put(
    '/api/shop/branches/:id',
    permit('owner', 'manager'),
    data(async (d, r) => {
        need(ident(r.params.id) && typeof r.body.name === 'string' && r.body.name.trim() &&
            r.body.name.length <= 120, 'Valid branch name required');
        const b = await one(
            d,
            `UPDATE branches
             SET name=$1,address=$2,open_time=$3,
                 close_time=$4,active=$5
             WHERE id=$6 AND tenant_id=$7
             RETURNING *`,
            [
                r.body.name.trim(),
                r.body.address || '',
                r.body.open_time || '07:00',
                r.body.close_time || '21:00',
                r.body.active !== false,
                r.params.id,
                r.tenant
            ]
        );

        if (!b) throw fail(404, 'Not found');
        return b;
    })
);

app.get('/api/shop/branches/:id/schedule', data(async (db, req) => {
    need(ident(req.params.id), 'Invalid branch');
    const schedule = await branchSchedule(db, req.tenant, req.params.id);
    if (!schedule) throw fail(404, 'Branch unavailable');
    return schedule;
}));

app.put('/api/shop/branches/:id/schedule', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid branch');
    if (!await saveBranchSchedule(db, req.tenant, req.params.id, req.body)) throw fail(404, 'Branch unavailable');
    await audit(db, req, 'branch.schedule_updated', { branch: req.params.id });
    return { ok: true };
}));

// CATEGORIES

app.get('/api/shop/categories', data((d, r) =>
    rows(
        d,
        'SELECT * FROM categories WHERE tenant_id=$1 ORDER BY name',
        [r.tenant]
    )
));

app.post(
    '/api/shop/categories',
    permit('owner', 'manager'),
    data((d, r) => {
        need(r.body.name?.trim(), 'Name required');

        return one(
            d,
            `INSERT INTO categories(tenant_id,name)
             VALUES($1,$2) RETURNING *`,
            [r.tenant, r.body.name.trim()]
        );
    })
);

app.delete(
    '/api/shop/categories/:id',
    permit('owner', 'manager'),
    data(async (d, r) => {
        await d.query(
            'DELETE FROM categories WHERE id=$1 AND tenant_id=$2',
            [r.params.id, r.tenant]
        );
        return { ok: true };
    })
);

// PRODUCTS

app.get('/api/shop/products', data(async (db, req) => {
    const products = await listProducts(db, req.tenant);
    if (req.modules.products) return products;
    return products.map(({ cost_cents, recipe, stock_item_id, variations, ...product }) => ({ ...product,
        variations: variations.map(({ recipe, ...variant }) => variant) }));
}));

app.post(
    '/api/shop/products',
    permit('owner', 'manager'),
    data(async (d, r) => {
        const {
            name,
            price_cents,
            cost_cents = 0,
            category_id = null,
            description = '',
            active = true,
            variations = [],
            recipe = []
        } = r.body;

        need(typeof name === 'string' && name.trim() && money(price_cents) && money(cost_cents) &&
            typeof active === 'boolean',
            'Invalid product');

        if (category_id) {
            need(
                await one(
                    d,
                    'SELECT id FROM categories WHERE id=$1 AND tenant_id=$2',
                    [category_id, r.tenant]
                ),
                'Invalid category'
            );
        }

        const extras = await productOptions(d,r.tenant,r.body);
        need(extras.track_inventory || recipe.length===0,'Non-stock items cannot have inventory-consuming recipes');
        let p;
        try {
            p = await one(d,
                `INSERT INTO products
                 (tenant_id,name,price_cents,cost_cents,category_id,description,active,
                  product_type,product_class,track_inventory,sku,barcode,brand,manufacturer,stock_item_id,image_url)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                 RETURNING *`,
                [r.tenant,name.trim(),price_cents,cost_cents,category_id,description,active,
                    extras.product_type,extras.product_class,extras.track_inventory,extras.sku,extras.barcode,extras.brand,extras.manufacturer,
                    extras.stock_item_id,extras.image_url]);
        } catch (error) { throw catalogConflict(error); }

        await saveVariations(d, r.tenant, p, variations);
        await replaceRecipe(d, r.tenant, 'product', p.id, recipe);

        return p;
    })
);

app.put(
    '/api/shop/products/:id',
    permit('owner', 'manager'),
    data(async (d, r) => {
        const {
            name,
            price_cents,
            cost_cents = 0,
            category_id = null,
            description = '',
            active = true,
            variations,
            recipe
        } = r.body;

        need(typeof name === 'string' && name.trim() && money(price_cents) && money(cost_cents) &&
            typeof active === 'boolean',
            'Invalid product');

        if (category_id) {
            need(
                await one(d,
                    'SELECT id FROM categories WHERE id=$1 AND tenant_id=$2',
                    [category_id, r.tenant]
                ),
                'Invalid category'
            );
        }

        const previous = await one(d,
            'SELECT * FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
            [r.params.id,r.tenant]);
        if (!previous) throw fail(404, 'Product unavailable');
        const extras = await productOptions(d,r.tenant,r.body,previous);
        if(recipe!==undefined)need(extras.track_inventory || recipe.length===0,
          'Non-stock items cannot have inventory-consuming recipes');
        if(!extras.track_inventory){
          if(recipe===undefined){
            const existingRecipe=await one(d,
              'SELECT 1 FROM recipes WHERE tenant_id=$1 AND product_id=$2 LIMIT 1',
              [r.tenant,previous.id]);
            if(existingRecipe)throw fail(409,'Remove the existing recipe before disabling inventory tracking');
          }
          if(variations===undefined){
            const existingVariation=await one(d,`SELECT 1 FROM variations v
              WHERE v.tenant_id=$1 AND v.product_id=$2 AND
              (v.stock_item_id IS NOT NULL OR EXISTS
               (SELECT 1 FROM variation_recipes vr WHERE vr.tenant_id=v.tenant_id
                 AND vr.variation_id=v.id)) LIMIT 1`,[r.tenant,previous.id]);
            if(existingVariation)throw fail(409,'Remove variation stock links before disabling inventory tracking');
          }else if(variations.some(v=>v.stock_item_id||v.use_custom_recipe||v.recipe?.length)){
            throw fail(400,'Remove variation stock links and recipes before disabling inventory tracking');
          }
        }
        let p;
        try {
            p = await one(d,
                `UPDATE products
                 SET name=$1,price_cents=$2,cost_cents=$3,
                     category_id=$4,description=$5,active=$6,
                     product_type=$9,product_class=$10,track_inventory=$11,sku=$12,barcode=$13,brand=$14,
                     manufacturer=$15,stock_item_id=$16,image_url=$17
                 WHERE id=$7 AND tenant_id=$8 RETURNING *`,
                [name.trim(),price_cents,cost_cents,category_id,description,active,
                 r.params.id,r.tenant,extras.product_type,extras.product_class,extras.track_inventory,extras.sku,extras.barcode,
                 extras.brand,extras.manufacturer,extras.stock_item_id,extras.image_url]);
        } catch (error) { throw catalogConflict(error); }

        if (variations !== undefined) await saveVariations(d, r.tenant, p, variations);
        if (recipe !== undefined) await replaceRecipe(d, r.tenant, 'product', p.id, recipe);

        return p;
    })
);

app.delete(
    '/api/shop/products/:id',
    permit('owner', 'manager'),
    data(async (d, r) => {
        await d.query(
            'UPDATE products SET active=false WHERE id=$1 AND tenant_id=$2',
            [r.params.id, r.tenant]
        );
        return { ok: true };
    })
);

//
// STRATIFYPOS
// GENERIC CRUD
// Addons, Suppliers, Ingredients,
// Tables, Expenses and Promotions
//

const simple = [
    [
        'addons',
        ['name', 'price_cents', 'active']
    ],
    [
        'suppliers',
        ['name', 'contact']
    ],
    [
        'tables',
        ['branch_id', 'label', 'seats']
    ],
    [
        'expenses',
        [
            'branch_id',
            'title',
            'amount_cents',
            'spent_on'
        ]
    ],
];

for (const [table, fields] of simple) {

    const sortColumn =
        table === 'expenses'
            ? 'spent_on DESC'
            : table === 'ingredients'
                ? 'name'
                : 'id';

    // -------------------------------------------
    // GET ALL RECORDS
    // -------------------------------------------

    app.get(
        `/api/shop/${table}`,
        data(async (db, req) => {
            return rows(
                db,
                `
                SELECT *
                FROM ${table}
                WHERE tenant_id = $1
                ORDER BY ${sortColumn}
                `,
                [req.tenant]
            );
        })
    );

    // -------------------------------------------
    // CREATE RECORD
    // -------------------------------------------

    app.post(
        `/api/shop/${table}`,
        permit('owner', 'manager'),
        data(async (db, req) => {

            need(
                fields
                    .filter(field =>
                        [
                            'name',
                            'label',
                            'title',
                            'code',
                            'kind',
                            'branch_id'
                        ].includes(field)
                    )
                    .every(field => req.body[field]),
                'Required fields missing'
            );

            if (req.body.branch_id) {
                const branch = await one(
                    db,
                    `
                    SELECT id
                    FROM branches
                    WHERE id = $1
                      AND tenant_id = $2
                    `,
                    [
                        req.body.branch_id,
                        req.tenant
                    ]
                );

                need(branch, 'Invalid branch');
            }

            const body = req.body;
            if (table === 'addons') {
                need(typeof body.name === 'string' && body.name.trim() && money(body.price_cents), 'Invalid add-on');
            }
            if (table === 'tables') {
                need(typeof body.label === 'string' && body.label.trim() && ident(body.branch_id) &&
                    Number.isInteger(body.seats) && body.seats > 0 && body.seats <= 100, 'Invalid table');
            }

            const values = fields.map(field => {
                if (
                    body[field] !== undefined &&
                    body[field] !== null
                ) {
                    return body[field];
                }

                if (field === 'active') {
                    return true;
                }

                if (
                    [
                        'quantity',
                        'low_stock_at',
                        'unit_cost_cents'
                    ].includes(field)
                ) {
                    return 0;
                }

                if (field === 'unit') {
                    return 'g';
                }

                return null;
            });

            const placeholders = fields
                .map((_, index) => `$${index + 2}`)
                .join(', ');

            const created = await one(
                db,
                `
                INSERT INTO ${table}
                (
                    tenant_id,
                    ${fields.join(', ')}
                )
                VALUES
                (
                    $1,
                    ${placeholders}
                )
                RETURNING *
                `,
                [
                    req.tenant,
                    ...values
                ]
            );

            return created;
        })
    );

    // -------------------------------------------
    // UPDATE RECORD
    // -------------------------------------------

    app.put(
        `/api/shop/${table}/:id`,
        permit('owner', 'manager'),
        data(async (db, req) => {

            need(
                ident(req.params.id),
                'Invalid record ID'
            );

            if (req.body.branch_id) {
                const branch = await one(
                    db,
                    `
                    SELECT id
                    FROM branches
                    WHERE id = $1
                      AND tenant_id = $2
                    `,
                    [
                        req.body.branch_id,
                        req.tenant
                    ]
                );

                need(branch, 'Invalid branch');
            }

            const body = req.body;
            if (table === 'addons') {
                need(typeof body.name === 'string' && body.name.trim() && money(body.price_cents) &&
                    (body.active === undefined || typeof body.active === 'boolean'), 'Invalid add-on');
            }
            if (table === 'tables') {
                need(typeof body.label === 'string' && body.label.trim() && ident(body.branch_id) &&
                    Number.isInteger(body.seats) && body.seats > 0 && body.seats <= 100, 'Invalid table');
                const current = await one(db, 'SELECT branch_id FROM tables WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                    [req.tenant, req.params.id]);
                if (current && current.branch_id !== body.branch_id) {
                    const previousOrder = await one(db, 'SELECT id FROM orders WHERE tenant_id=$1 AND table_id=$2 LIMIT 1',
                        [req.tenant, req.params.id]);
                    if (previousOrder) throw fail(409, 'A table with order history cannot move to another branch');
                }
            }

            const values = fields.map(
                field => body[field] ?? null
            );

            const assignments = fields
                .map(
                    (field, index) =>
                        field === 'active' ? `active = COALESCE($${index + 1}, active)` : `${field} = $${index + 1}`
                )
                .join(', ');

            const updated = await one(
                db,
                `
                UPDATE ${table}
                SET ${assignments}
                WHERE id = $${fields.length + 1}
                  AND tenant_id = $${fields.length + 2}
                RETURNING *
                `,
                [
                    ...values,
                    req.params.id,
                    req.tenant
                ]
            );

            if (!updated) {
                throw fail(
                    404,
                    'Record not found'
                );
            }

            return updated;
        })
    );

    // -------------------------------------------
    // DELETE RECORD
    // -------------------------------------------

    app.delete(
        `/api/shop/${table}/:id`,
        permit('owner', 'manager'),
        data(async (db, req) => {

            need(
                ident(req.params.id),
                'Invalid record ID'
            );

            await db.query(
                `
                DELETE FROM ${table}
                WHERE id = $1
                  AND tenant_id = $2
                `,
                [
                    req.params.id,
                    req.tenant
                ]
            );

            return {
                ok: true,
                message: 'Record deleted successfully'
            };
        })
    );
}

// STOCK ADJUSTMENT

app.get('/api/shop/promotions', data(async (db, req) => {
    if (!req.modules.promotions) return [];
    const rules = await rows(db, 'SELECT * FROM promotions WHERE tenant_id=$1 ORDER BY code, id', [req.tenant]);
    return rules.map(rule => ({ ...rule, offline_eligible: offlineEligible(rule) }));
}));
app.post('/api/shop/promotions', permit('owner', 'manager'), data(async (db, req) => {
    const rule = await savePromotion(db, req.tenant, req.body);
    await audit(db, req, 'promotion.created', { promotion: rule.id });
    return rule;
}));
app.put('/api/shop/promotions/:id', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid promotion');
    const rule = await savePromotion(db, req.tenant, req.body, req.params.id);
    await audit(db, req, 'promotion.updated', { promotion: rule.id });
    return rule;
}));
app.delete('/api/shop/promotions/:id', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid promotion');
    const result = await db.query('UPDATE promotions SET active=false WHERE tenant_id=$1 AND id=$2',
        [req.tenant, req.params.id]);
    if (!result.rowCount) throw fail(404, 'Promotion unavailable');
    await audit(db, req, 'promotion.deactivated', { promotion: req.params.id });
    return { ok: true };
}));

app.get('/api/shop/loyalty/accounts', permit('owner', 'manager'), data((db, req) => {
    const offset = Number(req.query.offset ?? 0);
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000, 'Invalid account page');
    return rows(db, 'SELECT id,code,name,points FROM loyalty_accounts WHERE tenant_id=$1 ORDER BY code LIMIT 50 OFFSET $2',
        [req.tenant, offset]);
}));

app.post('/api/shop/loyalty/accounts', permit('owner', 'manager'), data(async (db, req) => {
    const { name, code } = req.body;
    need(validLoyaltyCode(code) && typeof name === 'string' && name.trim() && name.length <= 120,
        'Enter an account name and a code of 3–32 letters, numbers or hyphens');
    const account = await one(db, `INSERT INTO loyalty_accounts (tenant_id,code,name)
        VALUES ($1,$2,$3) RETURNING id,code,name,points`, [req.tenant, code.trim().toUpperCase(), name.trim()]);
    await audit(db, req, 'loyalty.account_created', { account: account.id });
    return account;
}));

app.put('/api/shop/tables/:id/status', permit('owner', 'manager', 'cashier'), data(async (db, req) => {
    const { status } = req.body;
    need(ident(req.params.id) && ['available', 'reserved', 'unavailable'].includes(status), 'Invalid table status');
    if (req.role === 'cashier' && status !== 'available') throw fail(403, 'A manager must change reservations or availability');
    const table = await one(db, 'SELECT * FROM tables WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [req.tenant, req.params.id]);
    if (!table) throw fail(404, 'Table unavailable');
    if (req.role === 'cashier' && table.status !== 'occupied') throw fail(409, 'Only an occupied table can be cleared');
    if (table.status === 'occupied' && status !== 'available') throw fail(409, 'Clear the table first');
    const saved = await one(db, 'UPDATE tables SET status=$3,active_order_id=NULL WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [req.tenant, req.params.id, status]);
    await audit(db, req, 'table.status_updated', { table: table.id, previous: table.status, status, order: table.active_order_id });
    return saved;
}));

app.get('/api/shop/addons/:id/recipe', permit('owner', 'manager'), data((db, req) => {
    need(ident(req.params.id), 'Invalid add-on ID');
    return rows(db, 'SELECT ingredient_id, quantity FROM addon_recipes WHERE tenant_id=$1 AND addon_id=$2',
        [req.tenant, req.params.id]);
}));

app.put('/api/shop/addons/:id/recipe', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid add-on ID');
    const addon = await one(db, 'SELECT id FROM addons WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [req.tenant, req.params.id]);
    if (!addon) throw fail(404, 'Add-on unavailable');
    await replaceRecipe(db, req.tenant, 'addon', addon.id, req.body.recipe);
    return { ok: true };
}));

function stockItemInput(body) {
    const { name, unit = 'g', item_type = 'ingredient', inventory_category = '', unit_cost_cents = 0 } = body;
    const reorder = inventoryQuantity(body.low_stock_at ?? 0);
    need(typeof name === 'string' && name.trim() && name.length <= 120 &&
        typeof unit === 'string' && unit.trim() && unit.length <= 24 &&
        ['ingredient', 'product', 'supply', 'material', 'other'].includes(item_type) &&
        typeof inventory_category === 'string' && inventory_category.length <= 80 &&
        reorder >= 0 && money(unit_cost_cents), 'Invalid stock item');
    return [name.trim(), unit.trim(), reorder, unit_cost_cents, item_type, inventory_category.trim()];
}

async function stockMode(db, tenant) {
    const settings = await one(db, 'SELECT branch_stock_enabled FROM shop_settings WHERE tenant_id=$1 FOR SHARE', [tenant]);
    if (!settings) throw fail(409, 'Stock settings unavailable');
    return settings.branch_stock_enabled;
}

async function verifyStockLocation(db, tenant, branch) {
    if (branch === null || branch === undefined) return;
    need(ident(branch) && await one(db, 'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2', [tenant, branch]),
        'Invalid stock location');
}

app.get('/api/shop/ingredients', data((db, req) =>
    rows(db, `SELECT id,name,unit,item_type,inventory_category,low_stock_at,
        CASE WHEN $2 THEN quantity END AS quantity, CASE WHEN $2 THEN unit_cost_cents END AS unit_cost_cents
        FROM ingredients WHERE tenant_id=$1 ORDER BY name,id`, [req.tenant, req.branchIds === null])));

app.post('/api/shop/ingredients', permit('owner', 'manager'), data(async (db, req) => {
    const fields = stockItemInput(req.body);
    const quantity = inventoryQuantity(req.body.quantity ?? 0);
    need(quantity >= 0, 'Invalid opening quantity');
    const created = await one(db, `
        INSERT INTO ingredients (tenant_id,name,unit,low_stock_at,unit_cost_cents,item_type,inventory_category,quantity)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.tenant, ...fields, quantity]);
    if (quantity > 0) {
        await recordMovement(db, req.tenant, created.id, null, quantity, 'stock_in', 'Opening balance', req.user.id);
    }
    return created;
}));

app.put('/api/shop/ingredients/:id', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid stock item ID');
    const current = await one(db, 'SELECT * FROM ingredients WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [req.tenant, req.params.id]);
    if (!current) throw fail(404, 'Stock item unavailable');
    need(req.body.quantity === undefined || inventoryQuantity(req.body.quantity) === Number(current.quantity),
        'Use a stock movement to change the balance');
    const fields = stockItemInput({ ...current, ...req.body });
    return one(db, `
        UPDATE ingredients SET name=$3, unit=$4, low_stock_at=$5, unit_cost_cents=$6,
            item_type=$7, inventory_category=$8
        WHERE tenant_id=$1 AND id=$2 RETURNING *
    `, [req.tenant, current.id, ...fields]);
}));

app.delete('/api/shop/ingredients/:id', permit('owner', 'manager'), data(async (db, req) => {
    need(ident(req.params.id), 'Invalid stock item ID');
    const result = await db.query('DELETE FROM ingredients WHERE tenant_id=$1 AND id=$2 AND quantity=0',
        [req.tenant, req.params.id]);
    if (!result.rowCount) throw fail(409, 'Stock item is missing or still has stock');
    return { ok: true };
}));

app.put('/api/shop/stock/branch-mode', permit('owner'), data(async (db, req) => {
    need(req.body.enabled === true, 'Confirm branch inventory activation');
    const changed = await one(db, `
        UPDATE shop_settings SET branch_stock_enabled=true WHERE tenant_id=$1 AND NOT branch_stock_enabled
        RETURNING branch_stock_enabled
    `, [req.tenant]);
    if (changed) await audit(db, req, 'inventory.branch_mode_enabled');
    return { branch_stock_enabled: true };
}));

app.get('/api/shop/stock/balances', permit('owner', 'manager'), data(async (db, req) => {
    const branch = req.query.branch_id || req.branchIds?.[0] || null;
    if (req.branchIds !== null && !branch) throw fail(403, 'Select an assigned branch');
    await verifyStockLocation(db, req.tenant, branch);
    const enabled = await stockMode(db, req.tenant);
    if (branch && !enabled) throw fail(409, 'Branch inventory is unavailable');
    const balances = await listBalances(db, req.tenant, branch);
    return { branch_stock_enabled: enabled, branch_id: branch, items: req.branchIds === null ? balances :
        balances.map(({ quantity, unit_cost_cents, ...item }) => ({ ...item, quantity: item.available })) };
}));

app.post('/api/shop/stock/adjust', permit('owner', 'manager'), data(async (db, req) => {
    const { ingredient_id, reason, branch_id = null, movement_type = 'adjustment' } = req.body;
    const delta = inventoryQuantity(req.body.delta);
    need(ident(ingredient_id) && delta !== 0 &&
        typeof reason === 'string' && reason.trim() && reason.length <= 300 &&
        ['stock_in', 'stock_out', 'adjustment'].includes(movement_type) &&
        (movement_type !== 'stock_in' || delta > 0) && (movement_type !== 'stock_out' || delta < 0),
        'Invalid stock movement');
    await verifyStockLocation(db, req.tenant, branch_id);
    const mode = await stockMode(db, req.tenant);
    if (req.branchIds !== null && (!branch_id || !mode)) throw fail(403, 'Shared stock requires workspace-wide access');
    const item = await changeStock(db, req.tenant, ingredient_id, branch_id, delta, mode);
    await recordMovement(db, req.tenant, ingredient_id, branch_id, delta, movement_type, reason.trim(), req.user.id);
    return item;
}));

app.post('/api/shop/stock/transfer', permit('owner', 'manager'), data(async (db, req) => {
    const { ingredient_id, from_branch_id = null, to_branch_id = null, reason = 'Stock transfer' } = req.body;
    const quantity = inventoryQuantity(req.body.quantity);
    if (req.branchIds !== null && (!from_branch_id || !to_branch_id)) throw fail(403, 'Shared stock requires workspace-wide access');
    need(ident(ingredient_id) && from_branch_id !== to_branch_id && quantity > 0 &&
        typeof reason === 'string' && reason.trim() && reason.length <= 300, 'Invalid stock transfer');
    await verifyStockLocation(db, req.tenant, from_branch_id);
    await verifyStockLocation(db, req.tenant, to_branch_id);
    if (!await stockMode(db, req.tenant)) throw fail(409, 'Enable branch inventory first');
    return transferStock(db, req.tenant, ingredient_id, from_branch_id, to_branch_id, quantity, reason.trim(), req.user.id);
}));

app.get('/api/shop/stock/movements', data(async (db, req) => {
    const branch = req.query.branch_id === 'unallocated' ? null : req.query.branch_id;
    await verifyStockLocation(db, req.tenant, branch);
    const offset = Number(req.query.offset ?? 0);
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000, 'Invalid movement page');
    return rows(db, `
        SELECT sm.*, i.name AS ingredient, b.name AS branch, u.name AS actor
        FROM stock_movements sm
        JOIN ingredients i ON i.tenant_id=sm.tenant_id AND i.id=sm.ingredient_id
        LEFT JOIN branches b ON b.tenant_id=sm.tenant_id AND b.id=sm.branch_id
        LEFT JOIN users u ON u.id=sm.actor_id
        WHERE sm.tenant_id=$1 AND ($2::boolean OR sm.branch_id IS NOT DISTINCT FROM $3::uuid)
        ORDER BY sm.created_at DESC, sm.id DESC LIMIT 50 OFFSET $4
    `, [req.tenant, branch === undefined, branch ?? null, offset]);
}));

// STAFF

async function checkStaffCapacity(db, tenant, existingUser = null) {
    const subscription = await one(db,`SELECT p.max_staff FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.tenant_id=$1 FOR UPDATE OF s`,[tenant]);
    const used = await one(db,`SELECT count(*)::int AS count FROM memberships WHERE tenant_id=$1 AND active
        AND user_id IS DISTINCT FROM $2::uuid`,[tenant,existingUser]);
    if (!subscription || used.count >= subscription.max_staff) throw fail(409,'Staff limit reached');
}

app.get(
    '/api/shop/staff',
    permit('owner', 'manager'),
    data((d, r) =>
        rows(
            d,
            `SELECT m.user_id,u.name,u.email,m.role,m.active,m.module_permissions,m.branch_ids
             FROM memberships m
             JOIN users u ON u.id=m.user_id
             WHERE m.tenant_id=$1
             ORDER BY u.name`,
            [r.tenant]
        )
    )
);

app.get('/api/shop/staff/role-permissions', permit('owner'), data((db,req) =>
    rows(db,'SELECT role,permissions FROM workspace_role_permissions WHERE tenant_id=$1 ORDER BY role',[req.tenant])));
app.put('/api/shop/staff/role-permissions', permit('owner'), data(async (db,req) => {
    const { role, permissions } = req.body;
    need(['manager','cashier','staff'].includes(role) && validPermissions(permissions),'Invalid role permissions');
    const saved = await one(db, `
        INSERT INTO workspace_role_permissions (tenant_id,role,permissions) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id,role) DO UPDATE SET permissions=excluded.permissions RETURNING role,permissions
    `,[req.tenant,role,permissions]);
    await audit(db,req,'staff.role_permissions_updated',{ role,permissions });
    return saved;
}));

app.put('/api/shop/staff/:id/access', permit('owner'), data(async (db, req) => {
    const { module_permissions = {}, branch_ids = null } = req.body;
    need(ident(req.params.id) && validPermissions(module_permissions) &&
        (branch_ids === null || Array.isArray(branch_ids) && branch_ids.length <= 100 &&
            branch_ids.every(ident) && new Set(branch_ids).size === branch_ids.length), 'Invalid member access');
    if (branch_ids?.length) {
        const found = await rows(db, 'SELECT id FROM branches WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [req.tenant, branch_ids]);
        need(found.length === branch_ids.length, 'Invalid assigned branch');
    }
    const member = await one(db, `
        UPDATE memberships SET module_permissions=$3,branch_ids=$4
        WHERE tenant_id=$1 AND user_id=$2 AND role<>'owner'
        RETURNING user_id,role,module_permissions,branch_ids
    `, [req.tenant, req.params.id, module_permissions, branch_ids]);
    if (!member) throw fail(404, 'Team member unavailable');
    await audit(db, req, 'staff.access_updated', { user: member.user_id, module_permissions, branch_ids });
    return member;
}));

app.post('/api/shop/staff', permit('owner', 'manager'), data(async (db, req) => {
    const { name, password, role } = req.body;
    const address = email(req.body.email);
    need(typeof name === 'string' && name.trim() && name.length <= 120 &&
        /^\S+@\S+\.\S+$/.test(address) && address.length <= 254 && address !== email(process.env.SUPERADMIN_EMAIL) &&
        typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 72 &&
        (req.role === 'owner' ? ['manager', 'cashier', 'staff'] : ['cashier', 'staff']).includes(role),
        'Enter a valid account, role and password of at least 12 characters');
    const subscription = await one(db, `
        SELECT p.max_staff FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.tenant_id=$1 FOR UPDATE OF s
    `, [req.tenant]);
    const used = await one(db, 'SELECT count(*)::int AS total FROM memberships WHERE tenant_id=$1 AND active', [req.tenant]);
    if (!subscription || used.total >= subscription.max_staff) throw fail(409, 'Staff limit reached');
    const created = await one(db, `
        INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email
    `, [name.trim(), address, await bcrypt.hash(password, 12)]);
    await db.query('INSERT INTO memberships (tenant_id,user_id,role) VALUES($1,$2,$3)',
        [req.tenant, created.id, role]);
    await audit(db, req, 'staff.created', { user: created.id, role });
    return { ...created, role };
}));

app.post(
    '/api/shop/staff/invite',
    permit('owner', 'manager'),
    data(async (d, r) => {
        const e = email(r.body.email);
        const role = r.body.role;

        need(
            /^\S+@\S+\.\S+$/.test(e) &&
            (r.role === 'owner' ? ['manager', 'cashier', 'staff'] : ['cashier', 'staff']).includes(role) &&
            e !== email(process.env.SUPERADMIN_EMAIL),
            'Invalid invitation'
        );

        const sub = await one(
            d,
            `SELECT p.max_staff
             FROM subscriptions s
             JOIN plans p ON p.id=s.plan_id
             WHERE s.tenant_id=$1`,
            [r.tenant]
        );

        const n = await one(
            d,
            'SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND active=true',
            [r.tenant]
        );

        need(n.n < sub.max_staff, 'Staff limit reached');

        const t = newToken();

        await d.query(
            `INSERT INTO invites
             (tenant_id,email,role,token_hash,expires_at)
             VALUES($1,$2,$3,$4,now()+interval '7 days')`,
            [r.tenant, e, role, hashToken(t)]
        );

        const sent = await sendMail(
            e,
            'Coffee shop invitation',
            `Join your coffee shop: ${appClientUrl}/invite?token=${t}`
        );

        await audit(d, r, 'staff.invite', { email: e, role });

        return {
            sent,
            ...(process.env.NODE_ENV === 'production'
                ? {}
                : {
                    developmentInviteLink:
                        `${appClientUrl}/invite?token=${t}`
                })
        };
    })
);

app.patch(
    '/api/shop/staff/:id',
    permit('owner'),
    data(async (d, r) => {
        need(
            ident(r.params.id) && ['manager', 'cashier', 'staff'].includes(r.body.role),
            'Invalid role'
        );

        if (r.body.active !== false) await checkStaffCapacity(d,r.tenant,r.params.id);
        const m = await one(
            d,
            `UPDATE memberships
             SET role=$1,active=$2
             WHERE user_id=$3 AND tenant_id=$4 AND role<>'owner'
             RETURNING *`,
            [r.body.role, r.body.active !== false, r.params.id, r.tenant]
        );

        if (!m) {
            throw fail(404, 'User missing or owner cannot be modified');
        }

        await audit(d, r, 'staff.update', { user: r.params.id });
        return m;
    })
);



// =====================================================
// DELETE STAFF ACCOUNT FROM DATABASE
// Owner only. Never delete a shop owner.
// =====================================================

app.delete(
    '/api/shop/staff/:id',
    permit('owner'),
    wrap(async (req, res) => {
        const tenantId = req.tenant;
        const targetId = req.params.id;

        need(ident(targetId), 'Invalid employee ID');

        if (targetId === req.user.id) {
            throw fail(403, 'You cannot delete your own account');
        }

        const db = await pool.connect();

        try {
            await db.query('BEGIN');

            // Check the employee belongs to THIS shop.
            const member = await one(
                db,
                `
                SELECT
                    m.user_id,
                    m.role,
                    u.name,
                    u.email
                FROM memberships m
                JOIN users u
                    ON u.id = m.user_id
                WHERE m.tenant_id = $1
                  AND m.user_id = $2
                FOR UPDATE OF m, u
                `,
                [tenantId, targetId]
            );

            if (!member) {
                throw fail(404, 'Employee not found in this shop');
            }

            // Never remove an Owner through Staff Management.
            if (member.role === 'owner') {
                throw fail(
                    403,
                    'Shop Owner cannot be deleted here'
                );
            }

            if (
                email(member.email) ===
                email(process.env.SUPERADMIN_EMAIL)
            ) {
                throw fail(
                    403,
                    'Platform Administrator cannot be deleted'
                );
            }

            // Check whether this account is shared
            // with any other coffee shop.
            const otherMemberships = await one(
                db,
                `
                SELECT COUNT(*)::int AS total
                FROM memberships
                WHERE user_id = $1
                  AND tenant_id <> $2
                `,
                [targetId, tenantId]
            );

            const sharedAccount = otherMemberships.total > 0;

            if (!sharedAccount) {
                // Preserve historical transaction and audit records.
                // Do not silently erase completed sales.
                const history = await one(
                    db,
                    `
                    SELECT
                        (
                            SELECT COUNT(*)::int
                            FROM orders
                            WHERE cashier_id = $1
                        ) AS orders_count,

                        (
                            SELECT COUNT(*)::int
                            FROM audit_logs
                            WHERE user_id = $1
                        ) AS audit_count,

                        (
                            SELECT COUNT(*)::int
                            FROM subscription_payments
                            WHERE recorded_by_user_id = $1
                        ) AS billing_count
                    `,
                    [targetId]
                );

                if (
                    history.orders_count > 0 ||
                    history.audit_count > 0 ||
                    history.billing_count > 0
                ) {
                    throw fail(
                        409,
                        'This employee has historical sales, audit, or billing records. Permanent account deletion is blocked to preserve those records.'
                    );
                }

                // Remove attendance records belonging to
                // this account in this shop.
                await db.query(
                    `
                    DELETE FROM attendance
                    WHERE tenant_id = $1
                      AND user_id = $2
                    `,
                    [tenantId, targetId]
                );
            }

            // Remove access to the selected shop.
            const membershipDeleted = await db.query(
                `
                DELETE FROM memberships
                WHERE tenant_id = $1
                  AND user_id = $2
                  AND role <> 'owner'
                `,
                [tenantId, targetId]
            );

            if (membershipDeleted.rowCount !== 1) {
                throw fail(409, 'Unable to remove employee membership');
            }

            // Cancel pending invitations for the same
            // email in this shop.
            await db.query(
                `
                DELETE FROM invites
                WHERE tenant_id = $1
                  AND LOWER(email) = LOWER($2)
                  AND accepted_at IS NULL
                `,
                [tenantId, member.email]
            );

            let accountDeleted = false;

            if (!sharedAccount) {
                // Remove password reset records.
                await db.query(
                    `
                    DELETE FROM password_tokens
                    WHERE user_id = $1
                    `,
                    [targetId]
                );

                // Delete actual user, registered email,
                // and password hash from PostgreSQL.
                const deleted = await db.query(
                    `
                    DELETE FROM users
                    WHERE id = $1
                      AND LOWER(email) <> LOWER($2)
                      AND NOT EXISTS (
                          SELECT 1
                          FROM memberships
                          WHERE user_id = $1
                      )
                    RETURNING id
                    `,
                    [
                        targetId,
                        process.env.SUPERADMIN_EMAIL || ''
                    ]
                );

                if (deleted.rowCount !== 1) {
                    throw fail(
                        409,
                        'Account could not be permanently deleted'
                    );
                }

                accountDeleted = true;
            }

            await db.query('COMMIT');

            res.json({
                ok: true,
                message: accountDeleted
                    ? 'Employee account and registered email permanently deleted.'
                    : 'Employee removed from this shop. Shared account preserved.',
                employee_name: member.name,
                membership_deleted: true,
                account_deleted: accountDeleted
            });

        } catch (error) {
            await db.query('ROLLBACK');

            if (error.code === '23503') {
                console.error('STAFF DELETE FK ERROR:', {
                    constraint: error.constraint,
                    table: error.table,
                    detail: error.detail
                });

                throw fail(
                    409,
                    'Employee account is referenced by other database records. Nothing was deleted.'
                );
            }

            throw error;

        } finally {
            db.release();
        }
    })
);


// ATTENDANCE

const teamManager = req => ['owner', 'manager'].includes(req.role);
app.get('/api/shop/attendance/status', data(async (db, req) =>
    ({ shift: await attendanceStatus(db, req.tenant, req.user.id) ?? null })));

for (const action of ['clock-in', 'clock-out', 'break-start', 'break-end']) {
    app.post('/api/shop/attendance/' + action, data((db, req) => {
        const branch = req.body?.branch_id || (req.branchIds?.length === 1 ? req.branchIds[0] : null);
        need(!branch || ident(branch), 'Invalid branch');
        return recordAttendance(db, req.tenant, req.user.id, action, branch, req.branchIds !== null);
    }));
}

app.get('/api/shop/attendance', data((db, req) => {
    const user = teamManager(req) ? req.query.user_id || null : req.user.id;
    need(!user || ident(user), 'Invalid employee');
    return attendanceHistory(db, req.tenant, user);
}));

app.get('/api/shop/attendance/summary', data((db, req) =>
    attendanceSummary(db, req.tenant, teamManager(req) ? null : req.user.id)));

app.get('/api/shop/staff/:id/schedule', permit('owner', 'manager'), data((db, req) => {
    need(ident(req.params.id), 'Invalid employee');
    return rows(db, 'SELECT * FROM work_schedules WHERE tenant_id=$1 AND user_id=$2 ORDER BY weekday',
        [req.tenant, req.params.id]);
}));

app.put('/api/shop/staff/:id/schedule', permit('owner', 'manager'), data(async (db, req) => {
    const { time_zone, shifts } = req.body;
    need(ident(req.params.id) && typeof time_zone === 'string' && time_zone.length <= 80 &&
        Array.isArray(shifts) && shifts.length <= 7, 'Invalid schedule');
    need(await one(db, 'SELECT name FROM pg_timezone_names WHERE name=$1', [time_zone]), 'Invalid time zone');
    const member = await one(db, 'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
        [req.tenant, req.params.id]);
    if (!member) throw fail(404, 'Employee unavailable');
    if (req.role !== 'owner' && member.role === 'owner') throw fail(403, 'Only the owner can edit this schedule');
    const weekdays = new Set();
    const clockTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
    for (const shift of shifts) {
        need(shift && Number.isInteger(shift.weekday) && shift.weekday >= 1 && shift.weekday <= 7 &&
            !weekdays.has(shift.weekday) && clockTime.test(shift.starts_at) && clockTime.test(shift.ends_at) &&
            shift.starts_at !== shift.ends_at && Number.isInteger(shift.grace_minutes) &&
            shift.grace_minutes >= 0 && shift.grace_minutes <= 180, 'Invalid or duplicate work shift');
        await verifyStockLocation(db, req.tenant, shift.branch_id);
        weekdays.add(shift.weekday);
    }
    for (const shift of shifts) {
        const previous = shifts.find(row => row.weekday===(shift.weekday===1 ? 7 : shift.weekday-1));
        need(!previous || previous.ends_at>=previous.starts_at || previous.ends_at<=shift.starts_at,
            'Overnight and following shifts must not overlap');
    }
    await db.query('DELETE FROM work_schedules WHERE tenant_id=$1 AND user_id=$2', [req.tenant, req.params.id]);
    for (const shift of shifts) {
        await db.query(`
            INSERT INTO work_schedules (tenant_id,user_id,weekday,branch_id,starts_at,ends_at,time_zone,grace_minutes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [req.tenant, req.params.id, shift.weekday, shift.branch_id ?? null, shift.starts_at,
            shift.ends_at, time_zone, shift.grace_minutes]);
    }
    await audit(db, req, 'staff.schedule_updated', { user: req.params.id });
    return { ok: true };
}));

// PHASE 2: operational routes inherit membership, module access and scoped RLS.
const operational = { data, permit, need, fail, audit, ident, money, stockMode };
registerRegisterRoutes(app, operational);
registerPurchasingRoutes(app, operational);
registerRefundRoutes(app, operational);
registerHoldRoutes(app, operational);
registerKitchenRoutes(app, operational);

// Transaction cost snapshots are manager/report data, not cashier receipt data.
const publicOrder = ({ estimated_cogs_cents, ...order }) => order;

// POS CHECKOUT

const checkout = quote => data(async (d, r) => {
        const {
            branch_id,
            items,
            order_type = null,
            table_id = null,
            payment_method = 'cash',
            amount_tendered_cents = null,
            promo_code = null,
            loyalty_code = null,
            service_customer_id = null
        } = r.body;

        need(
            ident(branch_id) &&
            Array.isArray(items) &&
            items.length > 0 &&
            items.length <= 100,
            'Invalid cart'
        );

        need(
            [null,'standard','dine_in', 'takeout', 'delivery'].includes(order_type) &&
            ['cash', 'gcash', 'maya', 'card'].includes(payment_method),
            'Invalid order type/payment'
        );

        const { client_sale_id, offline, expected, register_session_id = null, held_order_id = null,
            customer_request_id = null } = r.body;
        if(customer_request_id && (quote || offline || held_order_id || !ident(customer_request_id))) {
            throw fail(400,'Invalid customer checkout reference');
        }
        const supervisorReplay = r.params.originalCashier !== undefined;
        const cashierId = r.params.originalCashier || r.user.id;
        if (supervisorReplay) need(ident(cashierId) && offline, 'A signed offline sale is required');
        let fingerprint = null;
        if (client_sale_id !== undefined) {
            need(ident(client_sale_id), 'Invalid transaction ID');
            fingerprint = hashToken(JSON.stringify(r.body));
            await d.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1, 602318))',
                [r.tenant + ':' + client_sale_id]
            );
            const existing = await one(d,
                'SELECT * FROM orders WHERE tenant_id=$1 AND client_sale_id=$2',
                [r.tenant, client_sale_id]);
            if (existing) {
                if (existing.cashier_id !== cashierId || existing.checkout_fingerprint !== fingerprint) {
                    throw fail(409, 'Transaction ID is already in use');
                }
                const savedItems = await rows(d,
                    'SELECT product_name AS name, variation_name AS variation, addons, quantity, total_cents FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_position, id',
                    [r.tenant, existing.id]);
                const memberships=await rows(d,`SELECT e.id AS entitlement_id,e.plan_id,
                    ev.event_kind,ev.expires_on,e.customer_id FROM service_entitlement_events ev
                    JOIN service_entitlements e ON e.tenant_id=ev.tenant_id AND e.id=ev.entitlement_id
                    WHERE ev.tenant_id=$1 AND ev.source_order_id=$2 AND ev.event_kind IN ('grant','renew')`,
                    [r.tenant,existing.id]);
                return { ...publicOrder(existing), items: savedItems, memberships };
            }
        }

        let customerRequest = null;
        if(!quote && customer_request_id){
            customerRequest=await one(d,
              'SELECT * FROM customer_order_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
              [r.tenant,customer_request_id]);
            if(!customerRequest)throw fail(404,'Customer checkout request unavailable');
            if(customerRequest.status!=='payment_review')throw fail(409,'Customer payment has not been reviewed');
            if(customerRequest.branch_id!==branch_id || customerRequest.table_id!==table_id ||
                order_type!=='dine_in' || JSON.stringify(customerRequest.cart.map(item=>({
                    product_id:item.product_id,variation_id:item.variation_id||null,
                    addon_ids:[...(item.addon_ids||[])].sort(),quantity:item.quantity
                })))!==JSON.stringify(items.map(item=>({
                    product_id:item.product_id,variation_id:item.variation_id||null,
                    addon_ids:[...(item.addon_ids||[])].sort(),quantity:item.quantity
                }))) || customerRequest.payment_method!==payment_method) {
                throw fail(409,'Customer order details changed; restart the payment review');
            }
            if(['cashier','staff'].includes(r.role) && customerRequest.payment_method!=='cash'){
                throw fail(403,'Electronic customer payments require manager verification');
            }
            if(r.body.payment_verified!==true)throw fail(409,'Staff must explicitly confirm that full payment was received');
        }
        let heldOrder = null;
        if (!quote && held_order_id) {
            need(ident(held_order_id) && client_sale_id,
                'A held order requires a valid checkout request ID');
            heldOrder = await one(d,
                'SELECT * FROM parked_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                [r.tenant, held_order_id]);
            if (!heldOrder) throw fail(404,'Held order unavailable');
            if (heldOrder.status !== 'held') throw fail(409,'This held order was already finalized or cancelled');
            if (heldOrder.branch_id !== branch_id) throw fail(409,'Held order belongs to another branch');
            if ((heldOrder.service_customer_id||null)!==(service_customer_id||null))
              throw fail(409,'Held order customer has changed; start a new checkout');
            if (r.role === 'cashier' && heldOrder.cashier_id !== r.user.id) {
                throw fail(403,'This held order belongs to another cashier');
            }
        }
        let grant = null;
        if (offline !== undefined) {
            need(offline && client_sale_id && ident(offline.device_id) && payment_method === 'cash' &&
                expected, 'Invalid offline checkout');
            grant = verifyOfflineSaleGrant(offline.grant, {
                tenantId: r.tenant, branchId: branch_id, userId: cashierId, deviceId: offline.device_id
            }, offline.created_at);
            if (!grant) throw fail(403, 'Offline authorization could not be verified');
        }

        if ((promo_code || loyalty_code) && !r.modules.promotions) throw fail(403, 'Promotions and rewards are unavailable');
        need(!promo_code || typeof promo_code === 'string' && promo_code.length <= 100, 'Invalid promo code');
        need(!loyalty_code || !grant && validLoyaltyCode(loyalty_code), 'Reward accounts require an online sale');
        need(!table_id || order_type === 'dine_in' && ident(table_id), 'Invalid table');

        const selectedBranch = await one(
            d,
            `SELECT id,tenant_id,name
             FROM branches
             WHERE id=$1 AND tenant_id=$2 AND active=true`,
            [branch_id, r.tenant]
        );

        if (!selectedBranch) {
            throw fail(400, 'Invalid branch for this shop');
        }

        if (table_id) {
            const table = await one(d, `SELECT id,status FROM tables
                WHERE id=$1 AND branch_id=$2 AND tenant_id=$3 FOR UPDATE`, [table_id, branch_id, r.tenant]);
            need(table, 'Invalid table');
            if (!['available', 'reserved'].includes(table.status)) throw fail(409, 'The table is occupied or unavailable');
        }

        let subtotal = 0;
        const lines = [];
        const consumption = new Map();

        for (const x of items) {
            need(
                x && ident(x.product_id) &&
                (!x.variation_id || ident(x.variation_id)) &&
                (x.addon_ids === undefined || (Array.isArray(x.addon_ids) && x.addon_ids.length <= 50 &&
                    x.addon_ids.every(ident) && new Set(x.addon_ids).size === x.addon_ids.length)) &&
                Number.isInteger(x.quantity) &&
                x.quantity > 0 &&
                x.quantity <= 100,
                'Invalid quantity'
            );

            const p = await one(
                d,
                `SELECT *
                 FROM products
                 WHERE id=$1 AND tenant_id=$2 AND active=true FOR SHARE`,
                [x.product_id, r.tenant]
            );

            if (!p) {
                throw fail(400, 'Product unavailable for this shop');
            }

            let unit = p.price_cents;
            let variant = null;

            if (x.variation_id) {
                variant = await one(
                    d,
                    `SELECT *
                     FROM variations
                     WHERE id=$1 AND product_id=$2 AND tenant_id=$3`,
                    [x.variation_id, p.id, r.tenant]
                );

                if (!variant) throw fail(400, 'Invalid size');

                unit = variant.price_cents ?? p.price_cents + variant.price_delta_cents;
            }

            const addons = [];

            for (const id of x.addon_ids || []) {
                const ad = await one(
                    d,
                    `SELECT *
                     FROM addons
                     WHERE id=$1 AND tenant_id=$2 AND active=true FOR SHARE`,
                    [id, r.tenant]
                );

                if (!ad) throw fail(400, 'Invalid add-on');

                unit += ad.price_cents;

                addons.push({
                    id: ad.id,
                    name: ad.name,
                    price_cents: ad.price_cents
                });
            }

            need(unit >= 0, 'Negative price');
            if (grant && unit !== x.expected_unit_cents) {
                throw fail(409, 'Product or option price changed since the offline sale');
            }

            const total = unit * x.quantity;
            subtotal += total;

            need(
                Number.isSafeInteger(subtotal) && subtotal <= 100000000,
                'Order total too large'
            );

            lines.push({
                product: p,
                variant,
                addons,
                qty: x.quantity,
                unit,
                total
            });

            const recipe = p.track_inventory ? await rows(
                d,
                `SELECT ingredient_id,quantity FROM recipes
                 WHERE product_id=$1 AND tenant_id=$2 AND NOT $3::boolean
                 UNION ALL
                 SELECT ingredient_id,quantity FROM variation_recipes
                 WHERE variation_id=$4 AND tenant_id=$2 AND $3::boolean
                 UNION ALL
                 SELECT ingredient_id,quantity FROM addon_recipes
                 WHERE addon_id=ANY($5::uuid[]) AND tenant_id=$2`,
                [p.id, r.tenant, variant?.use_custom_recipe ?? false, variant?.id ?? null, addons.map(a => a.id)]
            ) : [];
            // When ingredients are consumed, capture their actual unit costs.
            // Otherwise preserve the catalog product cost at the instant of sale.
            const directStockId = p.product_type === 'physical' && p.track_inventory
                ? variant?.stock_item_id || p.stock_item_id : null;
            if (directStockId) {
                if (recipe.some(row=>row.ingredient_id===directStockId)) {
                    throw fail(409, 'Product inventory link duplicates a recipe ingredient');
                }
                consumption.set(directStockId, (consumption.get(directStockId)||0) + x.quantity*1000);
            }
            lines[lines.length - 1].hasRecipe = recipe.length > 0 || Boolean(directStockId);

            for (const ing of recipe) {
                const used = (consumption.get(ing.ingredient_id) || 0) +
                    Math.round(Number(ing.quantity) * 1000) * x.quantity;

                consumption.set(ing.ingredient_id, used);
            }
        }

        // Restaurant fulfillment applies only to explicitly classified food/beverage lines.
        const hasFood=lines.some(line=>line.product.product_class==='food_beverage');
        // Signed cash receipts prepared by the previous POS release used "takeout"
        // even for retail; retain their reconciliation without creating restaurant sales.
        const legacyOfflineStandard=Boolean(grant)&&!hasFood&&order_type==='takeout';
        const effectiveOrderType=legacyOfflineStandard?'standard':
          order_type ?? (hasFood?'takeout':'standard');
        if(hasFood ? effectiveOrderType==='standard' : effectiveOrderType!=='standard')
          throw fail(400,'Choose restaurant fulfillment only when the cart contains food or beverage');
        if(!hasFood && table_id)throw fail(400,'Only food/beverage orders can use restaurant tables');
        const membershipSelections=await validateMembershipCart(d,r.tenant,lines,{
          customerId:service_customer_id,offline:Boolean(offline),held:Boolean(heldOrder),
          qr:Boolean(customerRequest),promo:promo_code,loyalty:loyalty_code});
        if(membershipSelections.length && !r.modules.services)
          throw fail(403,'Customer Memberships module is unavailable to this workspace');
        // Inventory deduction inside same transaction

        const sortedConsumption = [...consumption.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, units]) => [id, units / 1000]);

        const settings = await one(d, 'SELECT * FROM shop_settings WHERE tenant_id=$1 FOR SHARE', [r.tenant]);
        if (!settings) throw fail(400, 'Shop settings unavailable');
        const loyalty = loyalty_code ? await one(d, `SELECT id,points FROM loyalty_accounts
            WHERE tenant_id=$1 AND code=$2 ${quote ? '' : 'FOR UPDATE'}`, [r.tenant, loyalty_code.trim().toUpperCase()]) : null;
        if (loyalty_code && !loyalty) throw fail(404, 'Reward account unavailable');
        const promotion = await orderPromotion(d, {
            tenant: r.tenant, role: r.role, branch: branch_id, code: promo_code, lines, offline: Boolean(grant), quote, loyalty
        });
        const discount = promotion.discount;
        const taxable = subtotal - discount;
        const tax = Math.round(
            taxable * settings.tax_basis_points / 10000
        );
        const service = Math.round(
            taxable * settings.service_basis_points / 10000
        );
        const total = taxable + tax + service;
        if(customerRequest && total!==Number(customerRequest.quoted_total_cents)){
            throw fail(409,'Customer total changed before payment confirmation. Cancel and resubmit the request.');
        }
        if (quote) return {
            subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, service_cents: service, total_cents: total,
            loyalty_points: loyalty?.points ?? null
        };
        if (grant && (
            settings.tax_basis_points !== grant.taxBasisPoints ||
            settings.service_basis_points !== grant.serviceBasisPoints
        )) throw fail(409, 'Tax or service charge changed since the offline sale');
        if (expected && (expected.subtotal_cents !== subtotal ||
            expected.discount_cents !== discount || expected.tax_cents !== tax ||
            expected.service_cents !== service || expected.total_cents !== total)) {
            throw fail(409, 'Checkout totals changed. Review current prices and discounts.');
        }

        let cashRegister = null;
        if (payment_method === 'cash') {
            need(
                money(amount_tendered_cents) &&
                amount_tendered_cents >= total,
                'Cash tendered is insufficient'
            );
            need(!register_session_id || ident(register_session_id), 'Invalid register session');
            if (grant && register_session_id) throw fail(409, 'Offline sales require separate cash reconciliation');
            if (!grant && settings.require_cash_register && !register_session_id) {
                throw fail(409, 'Open a cashier register before receiving cash');
            }
            if (register_session_id) {
                cashRegister = await one(d,
                    'SELECT * FROM register_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                    [r.tenant, register_session_id]);
                if (!cashRegister || cashRegister.status !== 'open' ||
                    cashRegister.cashier_id !== r.user.id || cashRegister.branch_id !== branch_id) {
                    throw fail(409, 'Cash register must be open and assigned to you in this branch');
                }
            }
        } else {
            need(!register_session_id, 'Only cash sales may use a cash register');
        }
        if (!grant && ['cashier','staff'].includes(r.role) && !cashRegister) {
            throw fail(409,'Open your own cash register before completing a shift sale');
        }

        const costComponents = [];
        for (const line of lines) {
            if (!line.hasRecipe) {
                const unitCost = Number(line.product.cost_cents || 0);
                if (unitCost) costComponents.push({
                    kind:'product',source:line.product.id,quantity:line.qty,unitCost,
                    extended:(unitCost*line.qty).toFixed(3)
                });
            }
        }
        // The stock row is locked and its unit cost snapshot is read in the
        // same transaction as the inventory debit and receipt insert.
        for (const [id, qty] of sortedConsumption) {
            const updatedStock = await changeStock(d, r.tenant, id, branch_id, -qty, settings.branch_stock_enabled);
            const unitCost = Number(updatedStock.unit_cost_cents);
            costComponents.push({
                kind:'stock',source:id,quantity:qty,unitCost,
                extended:(unitCost*qty).toFixed(3)
            });
        }
        const estimatedCogsCents = Math.round(
            costComponents.reduce((sum,component)=>sum+Number(component.extended),0)
        );
        need(Number.isSafeInteger(estimatedCogsCents) && estimatedCogsCents >= 0,
            'Unable to estimate transaction stock costs');
        const order = await one(
            d,
            `INSERT INTO orders
             (
                tenant_id,branch_id,cashier_id,order_type,table_id,service_customer_id,
                subtotal_cents,discount_cents,tax_cents,service_cents,
                total_cents,payment_method,amount_tendered_cents,
                change_cents,promo_code,client_sale_id,checkout_fingerprint,offline_device_id,
                created_at,synced_at,receipt_footer,promotion_id,loyalty_account_id,register_session_id,estimated_cogs_cents
             )
             VALUES
             ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              COALESCE($19::timestamptz, now()), CASE WHEN $18::uuid IS NOT NULL THEN now() END,$20,$21,$22,$23,$24)
             RETURNING *`,
            [
                r.tenant,
                branch_id,
                cashierId,
                effectiveOrderType,
                table_id,
                service_customer_id,
                subtotal,
                discount,
                tax,
                service,
                total,
                payment_method,
                amount_tendered_cents,
                payment_method === 'cash'
                    ? amount_tendered_cents - total
                    : 0,
                promotion.code, client_sale_id ?? null, fingerprint, offline?.device_id ?? null,
                offline?.created_at ?? null, grant?.receiptFooter ?? settings.receipt_footer, promotion.id, loyalty?.id ?? null,
                cashRegister?.id ?? null,
                estimatedCogsCents
            ]
        );

        if(customerRequest){
            await d.query(
              "UPDATE customer_order_requests SET status='confirmed',confirmed_at=now(),confirmed_by=$3,order_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
              [r.tenant,customerRequest.id,r.user.id,order.id]
            );
            await audit(d,r,'customer_order.payment_confirmed',{request_id:customerRequest.id,order_id:order.id,method:payment_method});
        }
        for (const [position, x] of lines.entries()) {
            await d.query(
                `INSERT INTO order_items
                 (
                    tenant_id,order_id,product_id,product_name,
                    variation_name,addons,quantity,
                    unit_price_cents,total_cents,line_position,variation_id,product_class
                 )
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                    r.tenant,
                    order.id,
                    x.product.id,
                    x.product.name,
                    x.variant?.name || null,
                    JSON.stringify(x.addons),
                    x.qty,
                    x.unit,
                    x.total, position, x.variant?.id ?? null, x.product.product_class
                ]
            );
        }

        // A paid membership activation is part of the very same transaction as this sale.
        // Any failure rolls back payment ledger, stock changes, and the entitlement.
        const membershipResults=await fulfillMembershipCheckout(
          d,r.tenant,order,service_customer_id,membershipSelections,r.user.id);
        await enqueueKitchenTicket(d,r.tenant,order);
        for (const component of costComponents) {
            await d.query(
                'INSERT INTO order_cost_components(tenant_id,branch_id,order_id,source_kind,source_id,quantity,unit_cost_cents,extended_cost_cents) ' +
                'VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                [r.tenant,branch_id,order.id,component.kind,component.source,
                    component.quantity,component.unitCost,component.extended]
            );
        }
        for (const [id, qty] of sortedConsumption) {
            await recordMovement(d, r.tenant, id, branch_id, -qty, 'sale', 'order', r.user.id, order.id);
        }

        if (cashRegister) {
            await d.query(
                'INSERT INTO register_movements(tenant_id,branch_id,session_id,actor_id,kind,amount_cents,reason,reference_id) ' +
                "VALUES($1,$2,$3,$4,'sale',$5,'POS checkout',$6)",
                [r.tenant,branch_id,cashRegister.id,r.user.id,total,order.id]);
        }
        if (heldOrder) {
            await d.query(
                "UPDATE parked_orders SET status='completed',completed_order_id=$3,completed_at=now(),updated_at=now() " +
                'WHERE tenant_id=$1 AND id=$2',
                [r.tenant,heldOrder.id,order.id]
            );
            await audit(d,r,'order.hold_completed',{held_order_id:heldOrder.id,order_id:order.id});
        }
        await recordLoyalty(d, r.tenant, loyalty?.id, order.id,
            loyalty ? Math.floor(taxable / settings.loyalty_cents_per_point) : 0, promotion.points || 0);

        if (table_id) {
            await d.query("UPDATE tables SET status='occupied', active_order_id=$3 WHERE tenant_id=$1 AND id=$2",
                [r.tenant, table_id, order.id]);
        }

        await audit(d, r, supervisorReplay ? 'order.offline_reconciled' : 'order.checkout', {
            id: order.id,
            total,
            ...(supervisorReplay ? { original_cashier: cashierId, client_sale_id } : {})
        });

        return {
            ...publicOrder(order),
            memberships:membershipResults,
            items: lines.map(x => ({
                name: x.product.name,
                variation: x.variant?.name,
                addons: x.addons,
                quantity: x.qty,
                total_cents: x.total
            }))
        };
});

app.post('/api/shop/checkout/quote', permit('owner', 'manager', 'cashier', 'staff'), checkout(true));
app.post('/api/shop/checkout/reconcile/:originalCashier', permit('owner', 'manager'), checkout(false));
app.post('/api/shop/checkout', permit('owner', 'manager', 'cashier', 'staff'), checkout(false));

// TRANSACTIONS

app.get('/api/shop/orders', data(async (d, r) =>
    (await rows(
        d,
        `SELECT o.*,u.name cashier,b.name branch
         FROM orders o
         JOIN users u ON u.id=o.cashier_id
         JOIN branches b
           ON b.id=o.branch_id AND b.tenant_id=o.tenant_id
         WHERE o.tenant_id=$1
         ORDER BY o.created_at DESC
         LIMIT 300`,
        [r.tenant]
    )).map(publicOrder)
));

app.get('/api/shop/orders/:id', data(async (d, r) => {
    const order = await one(
        d,
        'SELECT * FROM orders WHERE id=$1 AND tenant_id=$2',
        [r.params.id, r.tenant]
    );

    if (!order) throw fail(404, 'Order missing');

    order.items = await rows(
        d,
        `SELECT *
         FROM order_items
         WHERE order_id=$1 AND tenant_id=$2
         ORDER BY line_position, id`,
        [r.params.id, r.tenant]
    );

    return publicOrder(order);
}));

// SALES REPORTS

const report = wrap(async (req, res) => {
    const filters = reportFilters(req.query);
    const format = req.params.format;
    if (format && !['xlsx', 'pdf'].includes(format)) throw fail(400, 'Unknown export format');
    need(!filters.branch_id || ident(filters.branch_id), 'Invalid branch');
    const data = await scoped(req.tenant, async db => {
        if (filters.branch_id) {
            const branch = await one(db, 'SELECT name FROM branches WHERE tenant_id=$1 AND id=$2',
                [req.tenant, filters.branch_id]);
            if (!branch) throw fail(404, 'Branch unavailable');
            filters.branch_name = branch.name;
        }
        return loadReport(db, req.tenant, filters, Boolean(format), req.branchIds !== null);
    }, { consistentRead: true, ...scopeOptions(req) });
    res.set('Cache-Control', 'no-store');
    if (!format) return res.json(data);
    const { excelReport, pdfReport } = await import('./report-exports.js');
    const buffer = format === 'xlsx' ? await excelReport(data) : await pdfReport(data);
    const type = format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
    res.type(type).attachment('stratify-report-' + filters.from + '_' + filters.to + '.' + format).send(Buffer.from(buffer));
});

app.get('/api/shop/reports', report);
app.get('/api/shop/reports/export/:format', report);

app.get(
    '/api/shop/audit',
    permit('owner', 'manager'),
    data((d, r) =>
        rows(
            d,
            `SELECT a.*,u.name
             FROM audit_logs a
             LEFT JOIN users u ON u.id=a.user_id
             WHERE a.tenant_id=$1
             ORDER BY a.created_at DESC
             LIMIT 200`,
            [r.tenant]
        )
    )
);

// SUBSCRIPTIONS

app.get('/api/shop/subscription', data((d, r) =>
    one(
        d,
        `SELECT s.*,p.title,p.price_cents,
                p.max_branches,p.max_staff
         FROM subscriptions s
         JOIN plans p ON p.id=s.plan_id
         WHERE s.tenant_id=$1`,
        [r.tenant]
    )
));

app.post('/api/shop/subscription/payments/:id/evidence', permit('owner'), receiptLimitByIp, receiptParser, wrap(receivePaymentEvidence));

app.get('/api/shop/subscription/history', permit('owner'), wrap(async (req, res) => {
    const requests = await scoped(req.tenant, db => rows(db, `
        SELECT id,requested_plan_id,approved_plan_id,payment_id,status,review_note,created_at,reviewed_at
        FROM plan_change_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100
    `, [req.tenant]));
    const payments = await rows(pool, `
        SELECT sp.id,sp.plan_id,sp.amount_cents,sp.currency,sp.method,sp.reference_no,sp.status,sp.paid_at,sp.period_start,sp.period_end,sp.notes,sp.created_at,
            sp.evidence_required,sp.submitted_at,sp.submitted_reference,sp.review_note,m.name AS method_name,
            COALESCE(sp.instructions_snapshot,m.instructions) AS instructions_snapshot
        FROM subscription_payments sp JOIN subscription_payment_methods m ON m.id=sp.method
        WHERE sp.tenant_id=$1 ORDER BY sp.created_at DESC LIMIT 100
    `, [req.tenant]);
    const events = await scoped(req.tenant, db => rows(db, `
        SELECT id,action,details,created_at FROM audit_logs
        WHERE tenant_id=$1 AND action IN ('subscription.adjusted','subscription.payment_verified','subscription.payment_rejected')
        ORDER BY created_at DESC LIMIT 100
    `, [req.tenant]));
    res.set('Cache-Control', 'no-store');
    res.json({ requests, payments: payments.map(payment => ({ ...payment, stage: paymentStage(payment) })), events });
}));

app.post('/api/shop/subscription/request-plan', permit('owner'), data(async (db, req) => {
    const { plan_id, method = 'gcash', discount_code } = req.body;
    const option = await customerMethod(db, method);
    const target = await one(db, 'SELECT id,price_cents FROM plans WHERE id=$1 AND active AND price_cents>0', [plan_id]);
    need(target, 'Select an available paid plan');
    await priceSubscription(db, target, discount_code);
    const current = await one(db, 'SELECT plan_id FROM subscriptions WHERE tenant_id=$1', [req.tenant]);
    need(current?.plan_id !== plan_id, 'Select a different plan');
    const alreadyOpen = await one(db, `
        SELECT id FROM plan_change_requests WHERE tenant_id=$1 AND status IN ('pending','awaiting_payment')
    `, [req.tenant]);
    if (alreadyOpen) throw fail(409, 'A plan change is already open');
    const request = await one(db, `
        INSERT INTO plan_change_requests (tenant_id,requested_by,requested_plan_id,requested_payment_method,discount_code)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.tenant, req.user.id, plan_id, option.id, discount_code?.trim().toUpperCase() || null]);
    await audit(db, req, 'subscription.plan_request', { plan: plan_id, request: request.id });
    return request;
}));

// ======================================================
// CREMA COFFEE SAAS - SUPER ADMIN API
// ======================================================

// Only authenticated platform super admins may use these routes.
app.use('/api/admin', auth, admin);
app.use('/api/admin', platformRouter(wrap));
app.use('/api/admin', backupRouter(wrap));

app.get('/api/admin/payment-methods', wrap(async (_req, res) => {
    res.set('Cache-Control','no-store').json(await rows(pool,
        'SELECT id,name,instructions,customer_enabled FROM subscription_payment_methods ORDER BY name,id'));
}));

app.put('/api/admin/payment-methods/:id', wrap(async (req, res) => {
    const { name, instructions, customer_enabled } = req.body;
    need(/^[a-z][a-z0-9_]{1,31}$/.test(req.params.id) &&
        typeof name === 'string' && name.trim() && name.trim().length <= 80 &&
        typeof instructions === 'string' && instructions.length <= 4000 &&
        typeof customer_enabled === 'boolean' && (!customer_enabled || instructions.trim()), 'Invalid payment method configuration');
    const saved = await inTransaction(pool, async db => {
        const result = await one(db, `
        INSERT INTO subscription_payment_methods (id,name,instructions,customer_enabled)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET name=excluded.name,instructions=excluded.instructions,
            customer_enabled=excluded.customer_enabled
        RETURNING *
    `, [req.params.id,name.trim(),instructions.trim(),customer_enabled]);
        await platformAudit(db,req.user,'payment_method.updated',req.params.id,{ customer_enabled });
        return result;
    });
    res.json(saved);
}));

app.get('/api/admin/payments/:id/evidence', wrap(async (req, res) => {
    need(ident(req.params.id), 'Invalid payment ID');
    const receipt = await one(pool, 'SELECT mime_type,contents FROM subscription_payment_receipts WHERE payment_id=$1',
        [req.params.id]);
    if (!receipt) throw fail(404, 'Receipt unavailable');
    const extension = receipt.mime_type === 'image/png' ? 'png' : 'jpg';
    res.set('Cache-Control', 'private, no-store')
        .attachment('receipt-' + req.params.id + '.' + extension)
        .type(receipt.mime_type).send(receipt.contents);
}));


app.get('/api/admin/plan-requests', wrap(async (_req, res) => {
    res.json(await rows(pool, `
        SELECT r.*, t.name AS business, u.name AS requested_by_name
        FROM plan_change_requests r JOIN tenants t ON t.id=r.tenant_id JOIN users u ON u.id=r.requested_by
        WHERE t.archived_at IS NULL
        ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 100
    `));
}));

app.post('/api/admin/plan-requests/:id/review', wrap(async (req, res) => {
    const { decision, plan_id, note = '' } = req.body;
    need(ident(req.params.id) && ['approve','reject'].includes(decision) &&
        typeof note === 'string' && note.length <= 500 && (decision !== 'reject' || note.trim()),
        'Enter a valid review decision and rejection reason');
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query(`SELECT t.id FROM tenants t JOIN plan_change_requests r ON r.tenant_id=t.id
            WHERE r.id=$1 FOR NO KEY UPDATE OF t`, [req.params.id]);
        const change = await one(db, `
            SELECT r.*, t.archived_at, s.plan_id AS current_plan FROM plan_change_requests r
            JOIN tenants t ON t.id=r.tenant_id JOIN subscriptions s ON s.tenant_id=t.id
            WHERE r.id=$1 FOR UPDATE OF r,s
        `, [req.params.id]);
        if (!change || change.archived_at) throw fail(404, 'Plan request unavailable');
        if (change.status !== 'pending') throw fail(409, 'Plan request has already been reviewed');
        let payment = null;
        let approvedPlan = null;
        if (decision === 'approve') {
            approvedPlan = await one(db, 'SELECT id,price_cents FROM plans WHERE id=$1 AND active AND price_cents>0',
                [plan_id || change.requested_plan_id]);
            need(approvedPlan && approvedPlan.id !== change.current_plan, 'Select a different available paid plan');
            const method = await customerMethod(db, req.body.method || change.requested_payment_method || 'gcash');
            const quote = await priceSubscription(db, approvedPlan, req.body.discount_code ?? change.discount_code);
            payment = await createCustomerPayment(db, change.tenant_id, quote, method, req.user.id);
        }
        const updated = await one(db, `
            UPDATE plan_change_requests SET status=$2,approved_plan_id=$3,payment_id=$4,review_note=$5,reviewed_at=now()
            WHERE id=$1 RETURNING *
        `, [change.id, payment ? 'awaiting_payment' : 'rejected', approvedPlan?.id ?? null, payment?.id ?? null, note.trim()]);
        await audit(db, { tenant: change.tenant_id, user: req.user }, 'subscription.plan_request_reviewed', {
            request: change.id, decision, plan: approvedPlan?.id, payment: payment?.id
        });
        await platformAudit(db,req.user,'plan_request.reviewed',change.id,{
            business:change.tenant_id,decision,plan:approvedPlan?.id ?? null,payment:payment?.id ?? null
        });
        await db.query('COMMIT');
        res.json(updated);
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }
}));


// Shared query for registered shops, subscriptions,
// expiration dates, and collected subscription payments.
const adminShopDetailsSql = `
    SELECT
        t.id,
        t.name,
        t.slug,
        t.status,
        t.created_at,
        t.archived_at, t.deactivated_at, t.administratively_suspended,

        s.plan_id,
        s.status AS subscription_status,
        s.trial_ends_at,
        s.current_period_ends_at,

        p.title AS plan_title,
        p.price_cents AS plan_price_cents,

        CASE
            WHEN s.status = 'trial'
                THEN s.trial_ends_at
            ELSE s.current_period_ends_at
        END AS subscription_expires_at,

        COALESCE(pay.paid_cents, 0)::bigint AS paid_cents,
        COALESCE(pay.payment_count, 0)::int AS payment_count,
        pay.last_payment_at,
        COALESCE(sales.gross_cents,0)::bigint AS customer_gross_collected_cents,
        COALESCE(refunds.refunded_cents,0)::bigint AS customer_refunds_cents,
        (COALESCE(sales.gross_cents,0)-COALESCE(refunds.refunded_cents,0))::bigint AS customer_net_collected_cents,
        COALESCE(sales.paid_orders,0)::int AS completed_customer_payments

    FROM tenants t

    LEFT JOIN subscriptions s
        ON s.tenant_id = t.id

    LEFT JOIN plans p
        ON p.id = s.plan_id

    LEFT JOIN LATERAL (
        SELECT
            COALESCE(SUM(amount_cents), 0) AS paid_cents,
            COUNT(*) AS payment_count,
            MAX(paid_at) AS last_payment_at
        FROM subscription_payments sp
        WHERE sp.tenant_id = t.id
          AND sp.status = 'paid'
    ) pay ON TRUE
    LEFT JOIN LATERAL (
        SELECT COALESCE(sum(o.total_cents),0)::bigint AS gross_cents,
               count(*)::int AS paid_orders
        FROM orders o WHERE o.tenant_id=t.id
        AND o.status IN ('paid','partially_refunded','refunded')
    ) sales ON TRUE
    LEFT JOIN LATERAL (
        SELECT COALESCE(sum(r.amount_cents),0)::bigint AS refunded_cents
        FROM sales_refunds r WHERE r.tenant_id=t.id
    ) refunds ON TRUE
`;

// ======================================================
// 1. SUPER ADMIN DASHBOARD OVERVIEW
// ======================================================

app.get(
    '/api/admin/overview',
    wrap(async (_req, res) => {
        const overview = await one(
            pool,
            `
            SELECT

                (
                    SELECT COUNT(*)::int
                    FROM tenants
                    WHERE archived_at IS NULL
                ) AS shops,

                (
                    SELECT COUNT(*)::int
                    FROM tenants
                    WHERE status = 'active'
                      AND archived_at IS NULL
                ) AS active_shops,

                (
                    SELECT COUNT(*)::int
                    FROM users
                ) AS users,

                (
                    SELECT COUNT(*)::int
                    FROM tenants t
                    JOIN subscriptions s
                        ON s.tenant_id = t.id
                    WHERE t.archived_at IS NULL
                      AND t.status = 'active'
                      AND (
                          (
                              s.status = 'active'
                              AND (
                                  s.current_period_ends_at IS NULL
                                  OR s.current_period_ends_at > NOW()
                              )
                          )
                          OR (
                              s.status = 'trial'
                              AND s.trial_ends_at > NOW()
                          )
                      )
                ) AS active_subscriptions,
                (SELECT count(*)::int FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
                    WHERE t.archived_at IS NULL AND t.status='active'
                    AND s.status='trial' AND s.trial_ends_at>now()) AS active_trials,

                (
                    SELECT COALESCE(SUM(amount_cents), 0)::bigint
                    FROM subscription_payments
                    WHERE status = 'paid'
                ) AS collected_cents,

                (
                    SELECT COALESCE(SUM(amount_cents), 0)::bigint
                    FROM subscription_payments
                    WHERE status = 'paid'
                      AND paid_at >= DATE_TRUNC('month', NOW())
                ) AS collected_this_month_cents,

                (
                    SELECT COUNT(*)::int
                    FROM subscription_payments
                    WHERE status = 'pending'
                ) AS pending_payments,
                (SELECT COALESCE(sum(total_cents),0)::bigint FROM orders
                  WHERE status IN ('paid','partially_refunded','refunded')) AS customer_gross_collected_cents,
                (SELECT COALESCE(sum(amount_cents),0)::bigint FROM sales_refunds) AS customer_refunds_cents,

                (
                    SELECT COUNT(*)::int
                    FROM tenants t
                    JOIN subscriptions s
                        ON s.tenant_id = t.id
                    WHERE t.archived_at IS NULL
                      AND s.status IN ('trial', 'active')
                      AND COALESCE(
                          CASE
                              WHEN s.status = 'trial'
                                  THEN s.trial_ends_at
                              ELSE s.current_period_ends_at
                          END,
                          'infinity'::timestamptz
                      )
                      BETWEEN NOW()
                          AND NOW() + INTERVAL '7 days'
                ) AS expiring_soon
            `
        );

        res.json(overview);
    })
);

// ======================================================
// 2. REGISTERED SHOPS
// ======================================================

app.get(
    '/api/admin/tenants',
    wrap(async (req, res) => {
        const includeArchived =
            req.query.include_archived === 'true';

        const list = await rows(
            pool,
            `
            ${adminShopDetailsSql}

            ${includeArchived
                ? ''
                : 'WHERE t.archived_at IS NULL'
            }

            ORDER BY t.created_at DESC
            `
        );

        res.json(list);
    })
);

// ======================================================
// 3. SUBSCRIPTION PAYMENT HISTORY
// ======================================================

app.get(
    '/api/admin/payments',
    wrap(async (req, res) => {
        const limit = Math.min(
            500,
            Math.max(1, Number(req.query.limit) || 200)
        );

        const tenantId = req.query.tenant_id;

        if (tenantId && !ident(tenantId)) {
            throw fail(400, 'Invalid shop ID');
        }

        const payments = await rows(
            pool,
            `
            SELECT
                sp.id,
                sp.tenant_id,
                t.name AS shop_name,
                sp.plan_id,
                sp.amount_cents,
                sp.currency,
                sp.method, pm.name AS method_name,
                sp.reference_no, sp.evidence_required, sp.submitted_at, sp.submitted_reference,
                sp.verified_reference, sp.review_note, sp.reviewed_at,
                sp.status,
                sp.paid_at,
                sp.created_at,
                sp.period_start,
                sp.period_end,
                sp.notes,
                u.name AS recorded_by

            FROM subscription_payments sp

            JOIN tenants t
                ON t.id = sp.tenant_id

            JOIN subscription_payment_methods pm ON pm.id=sp.method
            LEFT JOIN users u
                ON u.id = sp.recorded_by_user_id

            WHERE (
                $1::uuid IS NULL
                OR sp.tenant_id = $1::uuid
            )

            ORDER BY sp.created_at DESC

            LIMIT $2
            `,
            [tenantId || null, limit]
        );

        res.set('Cache-Control','no-store').json(payments.map(payment => ({ ...payment, stage: paymentStage(payment) })));
    })
);

// ======================================================
// 4. RECORD A SUBSCRIPTION PAYMENT
// ======================================================

app.post(
    '/api/admin/payments',
    wrap(async (req, res) => {
        const {
            tenant_id,
            plan_id,
            amount_cents,
            method,
            reference_no,
            notes = '',
            status = 'pending',
            period_start = null,
            period_end = null
        } = req.body;

        need(
    status === 'pending',
    'Payments must start as pending. Use Verify & Activate after confirming the actual payment.'
);

        need(
            ident(tenant_id) &&
            money(amount_cents) &&
            amount_cents > 0,
            'Valid shop and positive payment amount required'
        );

        need(typeof method === 'string' && await one(pool,
            'SELECT id FROM subscription_payment_methods WHERE id=$1',[method]), 'Invalid payment method');

        need(
            ['pending', 'paid', 'failed'].includes(status),
            'Invalid payment status'
        );

        need(
            typeof reference_no === 'string' &&
            reference_no.trim().length > 0 &&
            reference_no.length <= 120,
            'Payment reference required'
        );

        if (period_start || period_end) {
            need(
                period_start &&
                period_end &&
                /^\d{4}-\d{2}-\d{2}$/.test(period_start) &&
                /^\d{4}-\d{2}-\d{2}$/.test(period_end) &&
                period_end >= period_start,
                'Invalid billing period'
            );
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const shop = await one(
                client,
                `
                SELECT id, archived_at
                FROM tenants
                WHERE id = $1
                FOR UPDATE
                `,
                [tenant_id]
            );

            if (!shop || shop.archived_at) {
                throw fail(404, 'Shop unavailable');
            }

            const sub = await one(
                client,
                `
                SELECT plan_id
                FROM subscriptions
                WHERE tenant_id = $1
                `,
                [tenant_id]
            );

            if (!sub) {
                throw fail(404, 'Subscription unavailable');
            }

            need(
                !plan_id || plan_id === sub.plan_id,
                'Payment plan must match current subscription'
            );

            const payment = await one(
                client,
                `
                INSERT INTO subscription_payments (
                    tenant_id,
                    plan_id,
                    amount_cents,
                    method,
                    reference_no,
                    notes,
                    status,
                    paid_at,
                    period_start,
                    period_end,
                    recorded_by_user_id
                )

                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    CASE
                        WHEN $7 = 'paid'
                            THEN NOW()
                        ELSE NULL
                    END,
                    $8, $9, $10
                )

                RETURNING *
                `,
                [
                    tenant_id,
                    sub.plan_id,
                    amount_cents,
                    method,
                    reference_no.trim(),
                    String(notes).slice(0, 1000),
                    status,
                    period_start,
                    period_end,
                    req.user.id
                ]
            );

            await platformAudit(client,req.user,'payment.recorded',payment.id,{ business:tenant_id,method });
            await client.query('COMMIT');

            res.status(201).json(payment);

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    })
);


// ============================================================
// PAYMENT STATUS UPDATE
// Only reject pending payments here.
// Use Verify & Activate for paid subscriptions.
// ============================================================

app.patch(
    '/api/admin/payments/:id',
    wrap(async (req, res) => {
        need(
            ident(req.params.id),
            'Invalid payment ID'
        );

        need(
            req.body?.status === 'failed',
            'Use Verify & Activate to confirm a payment'
        );

        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        need(reason && reason.length <= 500, 'Enter a rejection reason');
        const payment = await one(pool, `
            WITH failed AS (
                UPDATE subscription_payments SET status='failed',review_note=$2,reviewed_at=now(),
                    notes=concat_ws(' | ', NULLIF(notes,''), NULLIF($2,''))
                WHERE id=$1 AND status='pending' RETURNING *
            ), plan_rejection AS (
                UPDATE plan_change_requests r SET status='rejected',
                    review_note=COALESCE(NULLIF($2,''),'Payment rejected'), reviewed_at=now()
                FROM failed WHERE r.payment_id=failed.id AND r.status='awaiting_payment'
            ), audit AS (
                INSERT INTO audit_logs (tenant_id,user_id,action,details)
                SELECT tenant_id,$3,'subscription.payment_rejected',jsonb_build_object('payment',id,'reason',$2)
                FROM failed
            ), platform_audit AS (
                INSERT INTO platform_audit_logs (actor_id,action,target,details)
                SELECT $3,'payment.rejected',id::text,jsonb_build_object('business',tenant_id,'method',method)
                FROM failed
            )
            SELECT * FROM failed
        `, [req.params.id, reason, req.user.id]);
        if (!payment) throw fail(404, 'Pending payment not found');

        res.json(payment);
    })
);





// ============================================================
// STRATIFYPOS - VERIFY GCASH PAYMENT AND ACTIVATE
// This route must be AFTER:
// app.use('/api/admin', auth, admin);
// ============================================================

app.post(
    '/api/admin/payments/:id/verify-and-activate',
    wrap(async (req, res) => {
        need(
            ident(req.params.id),
            'Invalid payment ID'
        );

        need(
            req.body?.confirmed_received === true,
            'Actual payment receipt must be verified'
        );

        const reference = paymentReference(req.body?.verified_reference ?? req.body?.gcash_reference_no);
        const note = req.body?.review_note ?? '';
        need(typeof note === 'string' && note.length <= 500, 'Invalid review note');

        const db = await pool.connect();

        try {
            await db.query('BEGIN');

            // Lock the business first so plan selection and payment review serialize consistently.
            const shop = await one(db, `
                SELECT t.id,t.archived_at,t.administratively_suspended FROM tenants t JOIN subscription_payments sp ON sp.tenant_id=t.id
                WHERE sp.id=$1 FOR NO KEY UPDATE OF t
            `, [req.params.id]);
            if (!shop) throw fail(404, 'Payment not found');
            if (shop.archived_at || shop.administratively_suspended) throw fail(409, 'Restore business access before activating a payment');
            const payment = await one(db, 'SELECT * FROM subscription_payments WHERE id=$1 FOR UPDATE', [req.params.id]);
            if (payment.status !== 'pending') throw fail(409, 'Only pending payments can be activated');
            if (payment.evidence_required && (!payment.submitted_at || payment.submitted_reference !== reference)) {
                throw fail(409, 'The verified reference must match the submitted receipt');
            }

            const selectedPlan = await one(
                db,
                `
                SELECT
                    id,
                    title,
                    price_cents
                FROM plans
                WHERE id = $1
                `,
                [payment.plan_id]
            );
            const approvedChange = await one(db,
                "SELECT id FROM plan_change_requests WHERE payment_id=$1 AND status='awaiting_payment'", [payment.id]);

            if (
                !selectedPlan ||
                selectedPlan.price_cents <= 0 ||
                (!approvedChange && !payment.evidence_required && Number(payment.amount_cents) !== Number(selectedPlan.price_cents))
            ) {
                throw fail(
                    409,
                    'Payment amount does not match the selected plan'
                );
            }

            await claimReference(db, payment, reference);

            // Lock the subscription for this business.
            const subscription = await one(
                db,
                `
                SELECT *
                FROM subscriptions
                WHERE tenant_id = $1
                FOR UPDATE
                `,
                [payment.tenant_id]
            );

            if (!subscription) {
                throw fail(
                    404,
                    'Subscription not found'
                );
            }

            // New subscription:
            // start now.
            //
            // Existing paid subscription:
            // extend from existing expiry if still valid.
            const period = await one(
                db,
                `
                SELECT GREATEST(
                    NOW(),
                    COALESCE(
                        $1::timestamptz,
                        NOW()
                    )
                ) AS starts_at
                `,
                [
                    subscription.status === 'active'
                        ? subscription.current_period_ends_at
                        : null
                ]
            );

            const renewed = await one(
                db,
                `
                UPDATE subscriptions

                SET
                    plan_id = $1,
                    status = 'active',
                    trial_ends_at = NULL,
                    current_period_ends_at =
                        $2::timestamptz
                        + INTERVAL '1 month'

                WHERE tenant_id = $3

                RETURNING *
                `,
                [
                    payment.plan_id,
                    period.starts_at,
                    payment.tenant_id
                ]
            );

            // Mark payment as verified.
            const updatedPayment = await one(
                db,
                `
                UPDATE subscription_payments

                SET
                    status = 'paid',
                    paid_at = NOW(),
                    verified_reference = $1,
                    gcash_reference_no = CASE WHEN method='gcash' THEN $1 ELSE NULL END,
                    review_note=$5,reviewed_at=now(),
                    period_start = $2::date,
                    period_end = $3::date,
                    notes = CONCAT(
                        COALESCE(notes, ''),
                        ' | Verified by Super Admin'
                    )

                WHERE id = $4
                  AND status = 'pending'

                RETURNING *
                `,
                [
                    reference,
                    period.starts_at,
                    renewed.current_period_ends_at,
                    payment.id,note.trim()
                ]
            );

            if (!updatedPayment) {
                throw fail(
                    409,
                    'Payment was already processed'
                );
            }

            // Business becomes active only now.
            const activatedBusiness = await one(
                db,
                `
                UPDATE tenants

                SET status = 'active'

                WHERE id = $1
                  AND archived_at IS NULL

                RETURNING id, name, status
                `,
                [payment.tenant_id]
            );

            if (!activatedBusiness) {
                throw fail(
                    409,
                    'Business activation failed'
                );
            }

            await db.query("UPDATE plan_change_requests SET status='applied' WHERE payment_id=$1 AND status='awaiting_payment'",
                [updatedPayment.id]);
            await audit(db, { tenant: payment.tenant_id, user: req.user }, 'subscription.payment_verified', {
                payment: payment.id, plan: renewed.plan_id, expires: renewed.current_period_ends_at
            });
            await platformAudit(db, req.user, 'payment.verified', payment.id, { business: payment.tenant_id, method: payment.method });
            await db.query('COMMIT');

            res.json({
                ok: true,
                message:
                    'Payment verified. Monthly subscription activated.',
                business: activatedBusiness,
                payment_id: updatedPayment.id,
                plan_id: renewed.plan_id,
                subscription_expires_at:
                    renewed.current_period_ends_at
            });

        } catch (error) {
            await db.query('ROLLBACK');

            if (error.code === '23505') {
                throw fail(
                    409,
                    'This transaction reference is already in use'
                );
            }

            throw error;

        } finally {
            db.release();
        }
    })
);


// ======================================================
// 6. SUSPEND / REACTIVATE SHOP
// ======================================================

app.patch(
    '/api/admin/tenants/:id',
    wrap(async (req, res) => {
        need(
            ident(req.params.id) &&
            ['active', 'suspended'].includes(req.body.status),
            'Invalid status'
        );

        const result = await inTransaction(pool,async db => {
            const tenant = await one(db,`
                UPDATE tenants SET status=$1,administratively_suspended=($1='suspended'),deactivated_at=NULL
                WHERE id=$2 AND archived_at IS NULL RETURNING *
            `,[req.body.status,req.params.id]);
            if (tenant) await platformAudit(db,req.user,'business.status_updated',tenant.id,{ status:tenant.status });
            return tenant;
        });

        if (!result) {
            throw fail(404, 'Shop not found');
        }

        res.json(result);
    })
);

// ======================================================
// 7. DELETE SHOP (SOFT DELETE / ARCHIVE)
// ======================================================


/**
 * CREMA COFFEE SAAS
 * PERMANENT SHOP DELETION
 *
 * Deletes:
 * - Shop and its tenant-specific records
 * - Exclusive owner/staff accounts
 * - Registered emails and password hashes
 *
 * Preserves:
 * - Accounts with memberships in other shops
 * - Super Admin account
 * - All other shops and their records
 *
 * All operations execute in one transaction.
 */

app.delete(
    '/api/admin/tenants/:id',
    wrap(async (req, res) => {

        need(
            ident(req.params.id),
            'Invalid shop ID'
        );

        const db = await pool.connect();

        try {
            await db.query('BEGIN');

            const shopId = req.params.id;

            // ========================================
            // 1. LOCK AND VERIFY SHOP
            // ========================================

            const shop = await one(
                db,
                `
                SELECT id, name
                FROM tenants
                WHERE id = $1
                FOR UPDATE
                `,
                [shopId]
            );

            if (!shop) {
                throw fail(404, 'Shop not found');
            }

            need(
                req.body?.confirmation === shop.name,
                'Type the exact shop name to confirm deletion'
            );

            console.log(
                '[SHOP DELETE] Starting:',
                shop.id
            );

            // ========================================
            // 2. FIND EXCLUSIVE OWNER / STAFF USERS
            // ========================================

            // No DISTINCT with FOR UPDATE.
            // A user is exclusive only when there
            // are no memberships in other shops.

            const exclusiveUsers = await rows(
                db,
                `
                SELECT u.id
                FROM users u

                WHERE EXISTS (
                    SELECT 1
                    FROM memberships m
                    WHERE m.user_id = u.id
                      AND m.tenant_id = $1
                )

                AND NOT EXISTS (
                    SELECT 1
                    FROM memberships other_m
                    WHERE other_m.user_id = u.id
                      AND other_m.tenant_id <> $1
                )

                AND LOWER(u.email) <> LOWER($2)

                FOR UPDATE OF u
                `,
                [
                    shopId,
                    process.env.SUPERADMIN_EMAIL || ''
                ]
            );

            const exclusiveUserIds =
                exclusiveUsers.map(u => u.id);

            console.log(
                '[SHOP DELETE] Exclusive accounts:',
                exclusiveUserIds.length
            );

            // Fail closed before any destructive mutation when ledger, checkout
            // cost or kitchen records would be orphaned. Existing immutable
            // financial journals must follow a documented retention/erasure
            // workflow rather than bypassing append-only triggers.
            const operationalHistory = await one(db,`
                SELECT (
                    (SELECT count(*) FROM register_sessions WHERE tenant_id=$1) +
                    (SELECT count(*) FROM register_movements WHERE tenant_id=$1) +
                    (SELECT count(*) FROM sales_refunds WHERE tenant_id=$1) +
                    (SELECT count(*) FROM purchase_orders WHERE tenant_id=$1) +
                    (SELECT count(*) FROM order_cost_components WHERE tenant_id=$1) +
                    (SELECT count(*) FROM kitchen_tickets WHERE tenant_id=$1) +
                    (SELECT count(*) FROM customer_order_requests WHERE tenant_id=$1) +
                    (SELECT count(*) FROM public_menu_links WHERE tenant_id=$1) +
                    (SELECT count(*) FROM parked_orders WHERE tenant_id=$1) +
                    (SELECT count(*) FROM service_entitlements WHERE tenant_id=$1) +
                    (SELECT count(*) FROM service_entitlement_events WHERE tenant_id=$1)
                )::bigint AS records
            `,[shopId]);
            if(Number(operationalHistory.records)>0){
                throw fail(409,'Business has retained operational records; archive the business or use the approved ledger-retention and erasure procedure.');
            }

            // ========================================
            // 3. DELETE SHOP DEPENDENT RECORDS
            // ========================================

            // Order matters because PostgreSQL
            // enforces foreign-key constraints.
            //
            // All table names are hardcoded below;
            // none come from user input.

            const deleteOrder = [

                // Read-only financial journals are protected by immutable triggers.
                // Tenant erasure is a separately audited privileged operation; do
                // not silently bypass the immutable ledger protection.
                // In deployments containing operational ledger data this requires
                // an explicit controlled retention/erasure procedure.
                // Child records referencing orders,
                // products or ingredients.
                'service_plans',
                'service_customers',
                'order_items',
                'stock_movements',
                'recipes',
                'variations',

                // Orders and employee activities.
                'orders',
                'loyalty_accounts',
                'attendance',
                'audit_logs',

                // Subscription billing records.
                'plan_change_requests',
                'subscription_payments',

                // Invitations and memberships.
                'invites',
                'workspace_role_permissions',
                'memberships',

                // Other shop records.
                'expenses',
                'promotions',
                'addons',
                'suppliers',

                // Physical tables must be removed
                // before branches.
                'tables',

                // Products before categories.
                'products',
                'categories',

                // Ingredients after recipes
                // and stock movements.
                'branch_stock_balances',
                'ingredients',

                // Branches after orders,
                // attendance and tables.
                'branches',

                // Subscription and shop settings.
                'shop_settings',
                'subscriptions'
            ];

            const deletedRecords = {};

            for (const table of deleteOrder) {

                const result = await db.query(
                    `
                    DELETE FROM ${table}
                    WHERE tenant_id = $1
                    `,
                    [shopId]
                );

                deletedRecords[table] =
                    result.rowCount;

                console.log(
                    `[SHOP DELETE] ${table}:`,
                    result.rowCount
                );
            }

            // ========================================
            // 4. DELETE SHOP
            // ========================================

            const deletedShop = await one(
                db,
                `
                DELETE FROM tenants
                WHERE id = $1
                RETURNING id, name
                `,
                [shopId]
            );

            if (!deletedShop) {
                throw fail(
                    404,
                    'Shop could not be deleted'
                );
            }

            // ========================================
            // 5. DELETE EXCLUSIVE USER ACCOUNTS
            // ========================================

            let deletedUsers = [];

            if (exclusiveUserIds.length > 0) {

                // Remove password reset tokens first.
                await db.query(
                    `
                    DELETE FROM password_tokens
                    WHERE user_id = ANY($1::uuid[])
                    `,
                    [exclusiveUserIds]
                );

                // Double-check that these accounts
                // have no remaining memberships.
                //
                // This also protects users who may
                // have access to another shop.

                deletedUsers = await rows(
                    db,
                    `
                    DELETE FROM users u
                    WHERE u.id = ANY($1::uuid[])

                      AND LOWER(u.email) <> LOWER($2)

                      AND NOT EXISTS (
                          SELECT 1
                          FROM memberships m
                          WHERE m.user_id = u.id
                      )

                    RETURNING u.id
                    `,
                    [
                        exclusiveUserIds,
                        process.env.SUPERADMIN_EMAIL || ''
                    ]
                );
            }

            // ========================================
            // 6. COMMIT ALL DELETIONS
            // ========================================

            await platformAudit(db, req.user, 'business.deleted', shopId);
            await db.query('COMMIT');

            console.log(
                '[SHOP DELETE] Completed:',
                shopId
            );

            res.json({
                ok: true,

                message:
                    'Shop and exclusive user accounts permanently deleted.',

                deleted_shop: deletedShop,

                deleted_user_count:
                    deletedUsers.length,

                deleted_records:
                    deletedRecords
            });

        } catch (error) {

            await db.query('ROLLBACK');

            console.error(
                '[SHOP DELETE] Failed:',
                {
                    code: error.code,
                    constraint: error.constraint,
                    table: error.table,
                    detail: error.detail,
                    message: error.message
                }
            );

            if (error.code === '23503') {
                throw fail(
                    409,
                    'Deletion blocked by a foreign-key dependency. No records were deleted. Check the server terminal for the exact constraint.'
                );
            }

            throw error;

        } finally {

            db.release();

        }
    })
);



// ======================================================
// 8. RESTORE ARCHIVED SHOP
// ======================================================

app.post(
    '/api/admin/tenants/:id/restore',
    wrap(async (req, res) => {
        need(
            ident(req.params.id),
            'Invalid shop ID'
        );

        const restored = await inTransaction(pool,async db => {
            const tenant = await one(db,`
                UPDATE tenants SET archived_at=NULL,status='suspended',administratively_suspended=true,deactivated_at=NULL
                WHERE id=$1 AND archived_at IS NOT NULL RETURNING id,name,status,archived_at
            `,[req.params.id]);
            if (tenant) await platformAudit(db,req.user,'business.restored',tenant.id,{ status:tenant.status });
            return tenant;
        });

        if (!restored) {
            throw fail(404, 'Archived shop not found');
        }

        res.json(restored);
    })
);

// ======================================================
// 9. UPDATE SHOP SUBSCRIPTION
// ======================================================

app.patch(
    '/api/admin/subscriptions/:id',
    wrap(async (req, res) => {
        need(
            ident(req.params.id),
            'Invalid shop ID'
        );

        const {
            status,
            plan_id,
            current_period_ends_at = null,
            trial_ends_at = null
        } = req.body;

        need(
            [
                'trial',
                'active',
                'past_due',
                'expired',
                'cancelled'
            ].includes(status) &&
            planId(plan_id),
            'Invalid subscription'
        );

        const expiry = current_period_ends_at || null;
        const trial = trial_ends_at || null;

        if (expiry) {
            need(
                !Number.isNaN(Date.parse(expiry)),
                'Invalid subscription expiration'
            );
        }

        if (trial) {
            need(
                !Number.isNaN(Date.parse(trial)),
                'Invalid trial expiration'
            );
        }

        if (status === 'trial') {
            need(
                !!trial,
                'Trial end date required'
            );
        }

        const updated = await scoped(
            req.params.id,
            async d => {
                const subscription = await one(
                d,
                `
                UPDATE subscriptions

                SET
                    plan_id = $1,
                    status = $2,
                    current_period_ends_at = $3,
                    trial_ends_at = $4

                WHERE tenant_id = $5

                RETURNING *
                `,
                [
                    plan_id,
                    status,
                    expiry,
                    trial,
                    req.params.id
                ]);
                if (subscription) await audit(d, { tenant: req.params.id, user: req.user }, 'subscription.adjusted', {
                    plan: plan_id, status, expires: expiry ?? trial
                });
                return subscription;
            }
        );

        if (!updated) {
            throw fail(404, 'Subscription missing');
        }

        res.json(updated);
    })
);

// ======================================================
// 10. UPDATE SUBSCRIPTION PLANS
// ======================================================

// ======================================================
// END OF SUPER ADMIN ROUTES
// ======================================================


app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const code = err.status || (
        err.code === '23505' ? 409 :
        err.code === '23503' ? 400 :
        err.code === '23514' ? 400 :
        500
    );

    if (code === 500) console.error(err);

    res.status(code).json({
        error: code === 500
            ? 'Internal server error'
            : err.code === '23505'
                ? 'Already exists'
                : err.message
    });
});

// START SERVER

const PORT = Number(process.env.PORT || 4000);

const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Coffee SaaS API on http://localhost:${server.address().port}`);
});
