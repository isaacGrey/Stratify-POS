import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, pool, rows } from './db.js';
import { fail, inTransaction, planId, platformAudit, platformPlans, provisionBusiness } from './platform.js';
import { modules, validPermissions } from './workspace-access.js';
import {registerPlatformNotifications} from './platform-notifications.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const emailPattern = /^\S+@\S+\.\S+$/;
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validName = (value, length = 120) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= length;
const reservedAdmin = value => value === email(process.env.SUPERADMIN_EMAIL);
const positive = (value, max) => Number.isInteger(value) && value > 0 && value <= max;
const validPassword = value => typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 72;
const requireId = value => { if (!uuid.test(value)) throw fail(400, 'Invalid record ID'); };

function pagination(query) {
    const offset = Number(query.offset ?? 0);
    const term = String(query.q || '').trim().slice(0,100);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw fail(400,'Invalid page offset');
    return { offset, term };
}

function fields(body, id, creating) {
    const { title, price_cents, max_branches, max_staff, trial_days = 0, active } = body;
    if (!planId(id) || (creating && !validName(title,80)) || (title !== undefined && !validName(title,80)) ||
        !Number.isInteger(price_cents) || price_cents < 0 || price_cents > 100_000_000 ||
        (id === 'free' ? price_cents !== 0 : price_cents === 0) || !positive(max_branches,10_000) ||
        !positive(max_staff,100_000) || !Number.isInteger(trial_days) || trial_days < 0 || trial_days > 365 ||
        (active !== undefined && typeof active !== 'boolean')) throw fail(400, 'Enter valid plan details and limits');
    return [id, title?.trim() ?? null, price_cents,max_branches,max_staff,trial_days,active ?? null];
}

export function platformRouter(wrap) {
    const router = Router();
    registerPlatformNotifications(router,wrap);

    router.get('/plans', wrap(async (_req,res) => res.json(await platformPlans(pool))));
    router.post('/plans', wrap(async (req,res) => {
        const args = fields(req.body,req.body.id,true);
        const saved = await inTransaction(pool, async db => {
            const plan = await one(db, `INSERT INTO plans (id,title,price_cents,max_branches,max_staff,trial_days,active)
                VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true)) RETURNING *`, args);
            await platformAudit(db,req.user,'plan.created',plan.id);
            return plan;
        });
        res.status(201).json(saved);
    }));
    router.put('/plans/:id', wrap(async (req,res) => {
        const args = fields(req.body,req.params.id,false);
        const saved = await inTransaction(pool, async db => {
            const plan = await one(db, `UPDATE plans SET title=COALESCE($2,title),price_cents=$3,max_branches=$4,max_staff=$5,
                trial_days=$6,active=COALESCE($7,active) WHERE id=$1 RETURNING *`,args);
            if (!plan) throw fail(404,'Plan unavailable');
            await platformAudit(db,req.user,'plan.updated',plan.id, { active: plan.active, trial_days: plan.trial_days });
            return plan;
        });
        res.json(saved);
    }));

    router.get('/access', wrap(async (req,res) => {
        const { offset,term } = pagination(req.query);
        const [plans,businesses] = await Promise.all([
            platformPlans(pool),
            rows(pool, `SELECT t.id,t.name,t.module_overrides,s.plan_id FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id
                WHERE t.archived_at IS NULL AND strpos(lower(t.name),lower($1))>0 ORDER BY t.name,t.id LIMIT 50 OFFSET $2`,
            [term,offset])
        ]);
        res.json({ modules,plans,businesses });
    }));
    for (const [resource, table, column, validate] of [
        ['plans','plans','module_access',planId], ['tenants','tenants','module_overrides',id => uuid.test(id)]
    ]) {
        router.put('/' + resource + '/:id/modules', wrap(async (req,res) => {
            if (!validate(req.params.id) || !validPermissions(req.body.modules)) throw fail(400,'Invalid module access configuration');
            const saved = await inTransaction(pool, async db => {
                const row = await one(db, `UPDATE ${table} SET ${column}=$2 WHERE id=$1 RETURNING id,${column}`,
                    [req.params.id,req.body.modules]);
                if (!row) throw fail(404,'Record unavailable');
                await platformAudit(db,req.user,resource + '.modules_updated',row.id,{ modules: req.body.modules });
                return row;
            });
            res.json(saved);
        }));
    }

    router.get('/users', wrap(async (req,res) => {
        const { offset,term } = pagination(req.query);
        const business=typeof req.query.business==='string'?req.query.business.trim().slice(0,120):'';
        res.json(await rows(pool, `SELECT u.id,u.name,u.email,u.active,u.archived_at,u.suspended_at,u.platform_admin,u.created_at,
            (SELECT count(*)::int FROM memberships m WHERE m.user_id=u.id) AS workspaces,
            (SELECT string_agg(DISTINCT t.name,', ' ORDER BY t.name) FROM memberships m
              JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=u.id) AS business_names
            FROM users u
            WHERE strpos(lower(u.name || ' ' || u.email),lower($1))>0
              AND ($3::text='' OR EXISTS (SELECT 1 FROM memberships m
               JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=u.id
                AND t.name ILIKE '%'||$3||'%'))
            ORDER BY u.created_at DESC,u.id LIMIT 50 OFFSET $2`, [term,offset,business]));
    }));
    router.post('/users', wrap(async (req,res) => {
        const { name,password } = req.body;
        const address = email(req.body.email);
        if (!validName(name) || !emailPattern.test(address) || address.length>254 || reservedAdmin(address) || !validPassword(password)) {
            throw fail(400,'Enter a valid name, email and password of at least 12 characters');
        }
        const hash = await bcrypt.hash(password,12);
        const saved = await inTransaction(pool, async db => {
            const user = await one(db,'INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,active',
                [name.trim(),address,hash]);
            await platformAudit(db,req.user,'user.created',user.id);
            return user;
        });
        res.status(201).json(saved);
    }));
    router.patch('/users/:id', wrap(async (req,res) => {
        requireId(req.params.id);
        const { name,state } = req.body;
        const address = req.body.email === undefined ? null : email(req.body.email);
        if ((name !== undefined && !validName(name)) ||
            (address !== null && (!emailPattern.test(address) || address.length>254 || reservedAdmin(address))) ||
            (state !== undefined && !['active','suspended','deactivated','archived'].includes(state))) throw fail(400,'Invalid account change');
        const saved = await inTransaction(pool, async db => {
            const user = await one(db,`UPDATE users SET name=COALESCE($2,name),email=COALESCE($3,email),
                active=CASE WHEN $4::text IS NULL THEN active ELSE $4='active' END,
                suspended_at=CASE WHEN $4 IS NULL THEN suspended_at WHEN $4='suspended' THEN now() END,
                archived_at=CASE WHEN $4 IS NULL THEN archived_at WHEN $4='archived' THEN now() END
                WHERE id=$1 AND NOT platform_admin RETURNING id,name,email,active,suspended_at,archived_at`,
            [req.params.id,name?.trim() ?? null,address,state ?? null]);
            if (!user) throw fail(404,'Editable account unavailable');
            if (address !== null || state !== undefined) await db.query(
                'UPDATE password_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
            await platformAudit(db,req.user,'user.updated',user.id,{ state: state ?? null });
            return user;
        });
        res.json(saved);
    }));
    router.delete('/users/:id', wrap(async (req,res) => {
        requireId(req.params.id);
        await inTransaction(pool, async db => {
            const user = await one(db,'SELECT id,email,active FROM users WHERE id=$1 AND NOT platform_admin FOR UPDATE',[req.params.id]);
            if (!user) throw fail(404,'Editable account unavailable');
            if (user.active || req.body.confirmation !== user.email) throw fail(409,'Deactivate the account and confirm its exact email');
            try {
                await db.query('DELETE FROM password_tokens WHERE user_id=$1',[user.id]);
                await db.query('DELETE FROM users WHERE id=$1',[user.id]);
            } catch (error) {
                if (error.code === '23503') throw fail(409,'Archive this account to preserve its business history');
                throw error;
            }
            await platformAudit(db,req.user,'user.deleted',user.id);
        });
        res.json({ ok:true });
    }));

    router.post('/tenants', wrap(async (req,res) => {
        const { name,plan_id,status = 'trial',period_end } = req.body;
        const owner = email(req.body.owner_email);
        if (!validName(name) || !planId(plan_id) || !emailPattern.test(owner) || !['trial','active','expired'].includes(status) ||
            (status === 'trial' && plan_id !== 'free') ||
            (status === 'active' && (plan_id === 'free' || typeof period_end !== 'string' || !(Date.parse(period_end)>Date.now())))) {
            throw fail(400,'Enter a valid business, owner, plan and period');
        }
        const created = await inTransaction(pool, async db => {
            const user = await one(db, 'SELECT id FROM users WHERE email=$1 AND active AND NOT platform_admin FOR SHARE',[owner]);
            const plan = await one(db, 'SELECT id,trial_days FROM plans WHERE id=$1 AND active',[plan_id]);
            if (!user || !plan || (status === 'trial' && plan.trial_days < 1)) throw fail(409,'The owner or plan is unavailable');
            const result = await provisionBusiness(db,{ ownerId:user.id,name,plan,status,end: status==='active' ? period_end : null });
            await platformAudit(db,req.user,'business.created',result.business.id,{ plan: plan_id, status });
            return result;
        });
        res.status(201).json(created);
    }));
    router.put('/tenants/:id/profile', wrap(async (req,res) => {
        requireId(req.params.id);
        const { name,state } = req.body;
        if (!validName(name) || (state !== undefined && !['active','suspended','deactivated','archived'].includes(state))) {
            throw fail(400,'Invalid business change');
        }
        const saved = await inTransaction(pool, async db => {
            const updated = await one(db,`UPDATE tenants SET name=$2,
                status=CASE WHEN $3::text IS NULL THEN status WHEN $3='active' THEN 'active' ELSE 'suspended' END,
                administratively_suspended=COALESCE($3<>'active',administratively_suspended),
                deactivated_at=CASE WHEN $3 IS NULL THEN deactivated_at WHEN $3='deactivated' THEN now() END,
                archived_at=CASE WHEN $3 IS NULL THEN archived_at WHEN $3='archived' THEN COALESCE(archived_at,now()) END
                WHERE id=$1 RETURNING id,name,status,archived_at,deactivated_at`, [req.params.id,name.trim(),state ?? null]);
            if (!updated) throw fail(404,'Business unavailable');
            await platformAudit(db,req.user,'business.updated',updated.id,{ state: state ?? null });
            return updated;
        });
        res.json(saved);
    }));

    router.get('/branches', wrap(async (req,res) => {
        const { offset,term } = pagination(req.query);
        res.json(await rows(pool,`SELECT b.*,t.name AS business,t.archived_at
            FROM branches b JOIN tenants t ON t.id=b.tenant_id
            WHERE strpos(lower(b.name || ' ' || t.name),lower($1))>0 ORDER BY t.name,b.name,b.id LIMIT 50 OFFSET $2`,[term,offset]));
    }));
    router.patch('/branches/:id', wrap(async (req,res) => {
        requireId(req.params.id);
        if (typeof req.body.active !== 'boolean') throw fail(400,'Invalid branch state');
        const saved = await inTransaction(pool, async db => {
            const row = await one(db,'UPDATE branches SET active=$2 WHERE id=$1 RETURNING id,tenant_id,active',
                [req.params.id,req.body.active]);
            if (!row) throw fail(404,'Branch unavailable');
            await platformAudit(db,req.user,'branch.updated',row.id,{ tenant: row.tenant_id,active:row.active });
            return row;
        });
        res.json(saved);
    }));

    router.get('/activity', wrap(async (req,res) => {
        const { offset,term } = pagination(req.query);
        res.json(await rows(pool,`SELECT a.id,a.action,a.target,a.details,a.created_at,u.name AS actor
            FROM platform_audit_logs a LEFT JOIN users u ON u.id=a.actor_id
            WHERE strpos(lower(a.action || ' ' || COALESCE(a.target,'')),lower($1))>0
            ORDER BY a.created_at DESC,a.id DESC LIMIT 50 OFFSET $2`,[term,offset]));
    }));
    router.get('/system-settings', wrap(async (_req,res) =>
        res.json(await one(pool,'SELECT public_name,support_email,maintenance_mode FROM platform_settings WHERE singleton'))));
    router.put('/system-settings', wrap(async (req,res) => {
        const { public_name } = req.body;
        const support = email(req.body.support_email);
        if (!validName(public_name,80) || (support && (!emailPattern.test(support) || support.length>254))) {
            throw fail(400,'Invalid platform settings');
        }
        const saved = await inTransaction(pool, async db => {
            const settings = await one(db,'UPDATE platform_settings SET public_name=$1,support_email=$2 WHERE singleton RETURNING *',
                [public_name.trim(),support]);
            await platformAudit(db,req.user,'system.settings_updated','platform');
            return settings;
        });
        res.json(saved);
    }));

    router.get('/inquiries', wrap(async (req,res) => {
        const { offset,term } = pagination(req.query);
        res.set('Cache-Control','no-store').json(await rows(pool,`SELECT * FROM public_inquiries
            WHERE strpos(lower(name || ' ' || email || ' ' || business),lower($1))>0
            ORDER BY (resolved_at IS NULL) DESC,created_at DESC,id LIMIT 50 OFFSET $2`,[term,offset]));
    }));
    router.patch('/inquiries/:id', wrap(async (req,res) => {
        requireId(req.params.id);
        if (typeof req.body.resolved!=='boolean') throw fail(400,'Invalid inquiry state');
        const result = await inTransaction(pool,async db => {
            const row = await one(db,`UPDATE public_inquiries SET resolved_at=CASE WHEN $2 THEN now() ELSE NULL END
                WHERE id=$1 RETURNING id,resolved_at`,[req.params.id,req.body.resolved]);
            if (!row) throw fail(404,'Inquiry unavailable');
            await platformAudit(db,req.user,'inquiry.updated',row.id,{ resolved:req.body.resolved });
            return row;
        });
        res.json(result);
    }));

    router.get('/subscription-promotions', wrap(async (_req,res) =>
        res.json(await rows(pool,'SELECT * FROM subscription_promotions ORDER BY active DESC,name,id'))));
    async function savePromotion(req,res) {
        const id = req.params.id || null;
        if (id) requireId(id);
        const { name,kind,value,active,plan_id = null,starts_at = null,expires_at = null } = req.body;
        const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() || null : null;
        if (!validName(name) || (code && !/^[A-Z0-9-]{1,40}$/.test(code)) || !['fixed','percent'].includes(kind) ||
            !positive(value,kind==='percent' ? 99 : 100_000_000) || typeof active !== 'boolean' ||
            (plan_id && (!planId(plan_id) || plan_id==='free')) ||
            [starts_at,expires_at].some(date => date !== null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) ||
            (starts_at && expires_at && Date.parse(starts_at)>=Date.parse(expires_at))) throw fail(400,'Invalid subscription promotion');
        const saved = await inTransaction(pool, async db => {
            const args = [name.trim(),code,plan_id || null,kind,value,starts_at,expires_at,active];
            const rule = id ? await one(db,`UPDATE subscription_promotions SET name=$1,code=$2,plan_id=$3,kind=$4,value=$5,
                starts_at=$6,expires_at=$7,active=$8 WHERE id=$9 RETURNING *`,[...args,id]) :
                await one(db,`INSERT INTO subscription_promotions (name,code,plan_id,kind,value,starts_at,expires_at,active)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,args);
            if (!rule) throw fail(404,'Promotion unavailable');
            await platformAudit(db,req.user,id ? 'subscription_promotion.updated' : 'subscription_promotion.created',rule.id);
            return rule;
        });
        res.status(id ? 200 : 201).json(saved);
    }
    router.post('/subscription-promotions',wrap(savePromotion));
    router.put('/subscription-promotions/:id',wrap(savePromotion));
    return router;
}
