import 'dotenv/config';
import { unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { one, pool, rows } from './db.js';
import { inTransaction, platformAudit } from './platform.js';
import { archivePath, backupConfiguration, dumpEncrypted, ensureBackupStore, restoreCandidate } from './backup-storage.js';

const heartbeat = () => pool.query('UPDATE backup_settings SET worker_heartbeat=now() WHERE singleton');

export function latestScheduleSlot(settings, now = new Date()) {
    const date = new Date(now);
    date.setUTCHours(settings.hour_utc,0,0,0);
    if (date>now) date.setUTCDate(date.getUTCDate()-1);
    while ((settings.frequency==='weekly' && date.getUTCDay()!==settings.weekday_utc) ||
        (settings.frequency==='monthly' && date.getUTCDate()!==settings.month_day_utc)) {
        date.setUTCDate(date.getUTCDate()-1);
    }
    return date;
}

async function notify(job, status) {
    const address = process.env.BACKUP_NOTIFY_EMAIL;
    if (!address) return;
    let result = 'failed';
    if (process.env.SMTP_HOST) {
        const port = Number(process.env.SMTP_PORT || 587);
        try {
            const transport = nodemailer.createTransport({ host:process.env.SMTP_HOST,port,secure:port===465,
                connectionTimeout:10000,socketTimeout:15000,
                auth:process.env.SMTP_USER ? { user:process.env.SMTP_USER,pass:process.env.SMTP_PASS } : undefined });
            await transport.sendMail({ from:process.env.MAIL_FROM,to:address,
                subject:'StratifyPOS ' + job.kind + ' ' + status,
                text:'Job ' + job.id + ' ' + status + '. Sign in to the Backups page for details.' });
            result = 'sent';
        } catch { /* The job history records delivery failure. */ }
    }
    await pool.query('UPDATE backup_jobs SET notification_status=$2 WHERE id=$1',[job.id,result]);
}

async function finish(job,status,{ size = null,result = {},message = null } = {}) {
    await inTransaction(pool, async db => {
        await db.query(`UPDATE backup_jobs SET status=$2,finished_at=now(),size_bytes=$3,result=$4,error=$5 WHERE id=$1`,
            [job.id,status,size,result,message]);
        if (job.kind==='restore') {
            await db.query('UPDATE platform_settings SET maintenance_mode=false WHERE singleton');
        }
        await platformAudit(db,null,job.kind + '.' + status,job.id,{ source:job.source_backup_id || null });
    });
    await notify(job,status);
}

async function prune(config,settings) {
    await ensureBackupStore(config);
    const expired = await rows(pool,`
        SELECT b.id FROM backup_jobs b WHERE b.kind='backup' AND b.status='succeeded' AND b.deleted_at IS NULL
            AND (b.delete_requested_at IS NOT NULL OR (b.finished_at<now()-$1::int*interval '1 day' AND EXISTS (
                SELECT 1 FROM backup_jobs newer WHERE newer.kind='backup' AND newer.status='succeeded'
                    AND newer.deleted_at IS NULL AND newer.delete_requested_at IS NULL AND newer.finished_at>b.finished_at
            )))
            AND NOT EXISTS (SELECT 1 FROM backup_jobs r WHERE r.source_backup_id=b.id AND r.status IN ('queued','running'))
        LIMIT 50
    `,[settings.retention_days]);
    for (const { id } of expired) {
        await inTransaction(pool, async db => {
            const current = await one(db,'SELECT id FROM backup_jobs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
            const restoration = await one(db,"SELECT id FROM backup_jobs WHERE source_backup_id=$1 AND status IN ('queued','running')",[id]);
            if (!current || restoration) return;
            await unlink(archivePath(config,id)).catch(error => { if (error.code!=='ENOENT') throw error; });
            await db.query('UPDATE backup_jobs SET deleted_at=now() WHERE id=$1',[id]);
            await platformAudit(db,null,'backup.removed',id);
        });
    }
}

export async function runBackupCycle() {
    const config = backupConfiguration();
    const lock = await pool.connect();
    let acquired = false;
    try {
        acquired = (await one(lock,'SELECT pg_try_advisory_lock(713025) AS locked')).locked;
        if (!acquired) return false;
        await heartbeat();
        const settings = await one(pool,'SELECT * FROM backup_settings WHERE singleton');
        // A prior worker can leave a running record when its connection and lock disappear.
        const interrupted = await rows(pool,"SELECT * FROM backup_jobs WHERE status='running'");
        for (const job of interrupted) {
            if (job.kind==='backup' && config.configured) {
                try {
                    await ensureBackupStore(config);
                    for (const suffix of ['','.partial']) {
                        await unlink(archivePath(config,job.id)+suffix).catch(error => { if (error.code!=='ENOENT') throw error; });
                    }
                } catch { /* The failed record remains visible if the volume is offline. */ }
            }
            await finish(job,'failed',{ message:'The backup worker was interrupted.' });
        }
        if (settings.enabled && config.configured) {
            const slot = latestScheduleSlot(settings);
            if (slot >= new Date(settings.changed_at)) {
                await pool.query(`INSERT INTO backup_jobs (kind,schedule_slot) VALUES ('backup',$1)
                    ON CONFLICT (schedule_slot) DO NOTHING`,[slot]);
            }
        }
        const job = await one(pool,`
            UPDATE backup_jobs SET status='running',started_at=now() WHERE id=(
                SELECT id FROM backup_jobs WHERE status='queued' ORDER BY (kind='restore') DESC,created_at,id
                FOR UPDATE SKIP LOCKED LIMIT 1
            ) RETURNING *
        `);
        if (job) {
            const timer = setInterval(() => { void heartbeat().catch(() => {}); },20000);
            try {
                let outcome;
                try {
                    if (job.kind==='backup') outcome = { size:await dumpEncrypted(config,job.id) };
                    else outcome = { result:await restoreCandidate(config,job.source_backup_id) };
                } catch (error) {
                    await finish(job,'failed',{ message:error.message.slice(0,240) });
                }
                if (outcome) await finish(job,'succeeded',outcome);
            } finally { clearInterval(timer); }
        }
        if (config.configured) await prune(config,settings);
        return Boolean(job);
    } finally {
        if (acquired) await lock.query('SELECT pg_advisory_unlock(713025)').catch(() => {});
        lock.release();
    }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    let stopping = false;
    process.once('SIGTERM',() => { stopping = true; });
    process.once('SIGINT',() => { stopping = true; });
    while (!stopping) {
        try { if (await runBackupCycle()) continue; }
        catch { console.error('Backup worker cycle failed. Check the configured database and storage.'); }
        if (!stopping) await delay(5000);
    }
    await pool.end();
}
