import { Router } from 'express';
import { one, pool, rows } from './db.js';
import { fail, inTransaction, platformAudit } from './platform.js';
import { archivePath, backupConfiguration, ensureBackupStore } from './backup-storage.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const integerIn = (value, min, max) => Number.isInteger(value) && value>=min && value<=max;

async function configured() {
    const config = backupConfiguration();
    try { await ensureBackupStore(config); }
    catch { throw fail(503,'The configured encrypted backup volume is unavailable'); }
    return config;
}

async function usableBackup(db,id,lock = false) {
    if (!uuid.test(id)) throw fail(400,'Invalid backup ID');
    const backup = await one(db,`SELECT id,finished_at,size_bytes FROM backup_jobs
        WHERE id=$1 AND kind='backup' AND status='succeeded' AND deleted_at IS NULL AND delete_requested_at IS NULL
        ${lock ? 'FOR UPDATE' : ''}`,[id]);
    if (!backup) throw fail(404,'Backup archive unavailable');
    return backup;
}

export function backupRouter(wrap) {
    const router = Router();
    router.get('/backups',wrap(async (_req,res) => {
        const [settings,jobs,platform] = await Promise.all([
            one(pool,'SELECT * FROM backup_settings WHERE singleton'),
            rows(pool,'SELECT * FROM backup_jobs ORDER BY created_at DESC,id DESC LIMIT 200'),
            one(pool,'SELECT maintenance_mode FROM platform_settings WHERE singleton')
        ]);
        const config = backupConfiguration();
        const storageAvailable = await ensureBackupStore(config).then(() => true,() => false);
        res.set('Cache-Control','no-store').json({ settings,jobs,storage_available:storageAvailable,
            restore_configured: Boolean(config.restoreUrl && config.restoreUrl!==process.env.DATABASE_URL),
            maintenance:platform.maintenance_mode,notifications_configured:Boolean(process.env.BACKUP_NOTIFY_EMAIL && process.env.SMTP_HOST) });
    }));
    router.put('/backups/settings',wrap(async (req,res) => {
        const { enabled,frequency,hour_utc,weekday_utc,month_day_utc,retention_days } = req.body;
        if (typeof enabled!=='boolean' || !['daily','weekly','monthly'].includes(frequency) ||
            !integerIn(hour_utc,0,23) || !integerIn(weekday_utc,0,6) ||
            !integerIn(month_day_utc,1,28) || !integerIn(retention_days,1,3650)) throw fail(400,'Invalid backup schedule');
        if (enabled) await configured();
        const settings = await inTransaction(pool,async db => {
            const saved = await one(db,`UPDATE backup_settings SET enabled=$1,frequency=$2,hour_utc=$3,weekday_utc=$4,
                month_day_utc=$5,retention_days=$6,changed_at=CASE
                    WHEN (enabled,frequency,hour_utc,weekday_utc,month_day_utc) IS DISTINCT FROM ($1,$2,$3,$4,$5)
                    THEN now() ELSE changed_at END WHERE singleton RETURNING *`,
                [enabled,frequency,hour_utc,weekday_utc,month_day_utc,retention_days]);
            await platformAudit(db,req.user,'backup.schedule_updated','platform',{ enabled,frequency,retention_days });
            return saved;
        });
        res.json(settings);
    }));
    router.post('/backups',wrap(async (req,res) => {
        await configured();
        const job = await inTransaction(pool,async db => {
            const row = await one(db,"INSERT INTO backup_jobs (kind,requested_by) VALUES ('backup',$1) RETURNING *",[req.user.id]);
            await platformAudit(db,req.user,'backup.queued',row.id);
            return row;
        });
        res.status(202).json(job);
    }));
    router.get('/backups/:id/download',wrap(async (req,res,next) => {
        const backup = await usableBackup(pool,req.params.id);
        const config = await configured();
        res.set('Cache-Control','private, no-store').download(archivePath(config,backup.id),'stratifypos-'+backup.id+'.dump.enc',
            error => { if (error) next(error.code==='ENOENT' ? fail(404,'Backup archive unavailable') : error); });
    }));
    router.delete('/backups/:id',wrap(async (req,res) => {
        if (req.body.confirmation !== 'DELETE BACKUP') throw fail(400,'Type DELETE BACKUP to confirm');
        await configured();
        await inTransaction(pool,async db => {
            const backup = await usableBackup(db,req.params.id,true);
            if (await one(db,"SELECT id FROM backup_jobs WHERE source_backup_id=$1 AND status IN ('queued','running')",[backup.id])) {
                throw fail(409,'This archive is being used for recovery');
            }
            await db.query('UPDATE backup_jobs SET delete_requested_at=now() WHERE id=$1',[backup.id]);
            await platformAudit(db,req.user,'backup.removal_requested',backup.id);
        });
        res.status(202).json({ status:'queued' });
    }));
    router.post('/backups/:id/restore',wrap(async (req,res) => {
        if (req.body.confirmation !== 'RESTORE TO EMPTY TARGET') throw fail(400,'Type RESTORE TO EMPTY TARGET to confirm');
        const config = await configured();
        if (!config.restoreUrl || config.restoreUrl===process.env.DATABASE_URL) throw fail(503,'Configure a separate empty recovery database');
        const job = await inTransaction(pool,async db => {
            const backup = await usableBackup(db,req.params.id,true);
            const settings = await one(db,'SELECT maintenance_mode FROM platform_settings WHERE singleton FOR UPDATE');
            if (settings.maintenance_mode) throw fail(409,'Another recovery is in progress');
            const row = await one(db,`INSERT INTO backup_jobs (kind,source_backup_id,requested_by)
                VALUES ('restore',$1,$2) RETURNING *`,[backup.id,req.user.id]);
            await db.query('UPDATE platform_settings SET maintenance_mode=true WHERE singleton');
            await platformAudit(db,req.user,'restore.queued',row.id,{ source:backup.id });
            return row;
        });
        res.status(202).json(job);
    }));
    router.post('/backups/:id/cancel-restore',wrap(async (req,res) => {
        if (!uuid.test(req.params.id)) throw fail(400,'Invalid recovery job ID');
        await inTransaction(pool,async db => {
            const job = await one(db,`UPDATE backup_jobs SET status='failed',finished_at=now(),error='Canceled before recovery started.'
                WHERE id=$1 AND kind='restore' AND status='queued' RETURNING id`,[req.params.id]);
            if (!job) throw fail(409,'Only a queued recovery can be canceled');
            await db.query('UPDATE platform_settings SET maintenance_mode=false WHERE singleton');
            await platformAudit(db,req.user,'restore.canceled',job.id);
        });
        res.json({ ok:true });
    }));
    return router;
}
