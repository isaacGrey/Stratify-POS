import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, mkdtemp, open, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const magic = Buffer.from('STRATIFY-BACKUP-1\0');
const nonceSize = 12;
const tagSize = 16;
const headerSize = magic.length + nonceSize;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function backupConfiguration() {
    const root = process.env.BACKUP_STORAGE_DIR || '';
    const encoded = process.env.BACKUP_ENCRYPTION_KEY_B64 || '';
    const key = Buffer.from(encoded,'base64');
    return { root, key, configured: isAbsolute(root) && key.length===32 && key.toString('base64')===encoded &&
        Boolean(process.env.DATABASE_URL), restoreUrl: process.env.BACKUP_RESTORE_DATABASE_URL || '' };
}

export async function ensureBackupStore(config) {
    if (!config.configured) throw new Error('Backup storage or encryption key is unconfigured.');
    try { await access(join(config.root,'.stratifypos-backup-store')); }
    catch { throw new Error('The configured backup volume is unavailable.'); }
}

export function archivePath(config,id) {
    if (!uuid.test(id)) throw new Error('Invalid backup ID.');
    return join(config.root,id+'.dump.enc');
}

function dbEnvironment(connection) {
    const url = new URL(connection);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
        throw new Error('Invalid PostgreSQL backup connection configuration.');
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key) &&
        !/^(DATABASE_URL|JWT_SECRET|SMTP_PASS|SUPERADMIN_PASSWORD|BACKUP_ENCRYPTION_KEY_B64|BACKUP_RESTORE_DATABASE_URL)$/i.test(key)));
    Object.assign(env,{
        PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port || '5432',
        PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),
        PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'15',
        PGAPPNAME:'StratifyPOS backup worker'
    });
    for (const [parameter,key] of [['sslmode','PGSSLMODE'],['sslrootcert','PGSSLROOTCERT'],['sslcert','PGSSLCERT'],['sslkey','PGSSLKEY']]) {
        if (url.searchParams.has(parameter)) env[key] = url.searchParams.get(parameter);
    }
    return env;
}

function utility(name, args, connection) {
    const child = spawn(name,args,{ env:dbEnvironment(connection),shell:false,windowsHide:true,
        stdio:['ignore','pipe','pipe'],signal:AbortSignal.timeout(60*60*1000) });
    // Command diagnostics can contain connection and schema data.
    child.stderr.resume();
    const complete = new Promise((resolve,reject) => {
        child.once('error',() => reject(new Error('PostgreSQL utility could not start or timed out.')));
        child.once('close',code => code===0 ? resolve() : reject(new Error('PostgreSQL utility failed with exit code '+code+'.')));
    });
    complete.catch(() => {});
    return { child, complete };
}

export async function dumpEncrypted(config,id) {
    await ensureBackupStore(config);
    const file = archivePath(config,id);
    const staging = file+'.partial';
    const nonce = randomBytes(nonceSize);
    const cipher = createCipheriv('aes-256-gcm',config.key,nonce,{ authTagLength:tagSize });
    cipher.setAAD(Buffer.from(id));
    await writeFile(staging,Buffer.concat([magic,nonce]),{ flag:'wx',mode:0o600 });
    let dump;
    try {
        dump = utility(process.env.PG_DUMP_BIN || 'pg_dump',['--format=custom','--no-password'],process.env.DATABASE_URL);
        await Promise.all([dump.complete,pipeline(dump.child.stdout,cipher,createWriteStream(staging,{ flags:'a' }))]);
        const { size } = await stat(staging);
        if (size<=headerSize) throw new Error('The backup archive was empty.');
        await appendFile(staging,cipher.getAuthTag());
        const fd = await open(staging,'r+');
        try { await fd.sync(); } finally { await fd.close(); }
        await rename(staging,file);
        return (await stat(file)).size;
    } catch (error) {
        dump?.child.kill();
        await unlink(staging).catch(() => {});
        throw error;
    }
}

async function decryptArchive(config,id,destination) {
    const file = archivePath(config,id);
    const fd = await open(file,'r');
    const header = Buffer.alloc(headerSize);
    const tag = Buffer.alloc(tagSize);
    let size;
    try {
        ({ size } = await fd.stat());
        if (size<=headerSize+tagSize) throw new Error('Encrypted archive is incomplete.');
        await fd.read(header,0,headerSize,0);
        await fd.read(tag,0,tagSize,size-tagSize);
    } finally { await fd.close(); }
    if (!header.subarray(0,magic.length).equals(magic)) throw new Error('Unrecognized backup archive format.');
    const decipher = createDecipheriv('aes-256-gcm',config.key,header.subarray(magic.length),{ authTagLength:tagSize });
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(tag);
    try {
        await pipeline(createReadStream(file,{ start:headerSize,end:size-tagSize-1 }),
            decipher,createWriteStream(destination,{ flags:'wx',mode:0o600 }));
    } catch { throw new Error('The archive could not be authenticated with the configured backup key.'); }
}

export async function restoreCandidate(config,id) {
    await ensureBackupStore(config);
    if (!config.restoreUrl || config.restoreUrl===process.env.DATABASE_URL) throw new Error('Configure a separate empty recovery database.');
    const target = new pg.Client({ connectionString:config.restoreUrl,connectionTimeoutMillis:15000 });
    const directory = await mkdtemp(join(tmpdir(),'stratify-restore-'));
    try {
        await target.connect();
        const lock = await target.query('SELECT pg_try_advisory_lock(713028) AS locked');
        if (!lock.rows[0].locked) throw new Error('A recovery verification is already running on the target.');
        const objects = await target.query(`
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname<>'information_schema' AND left(n.nspname,3)<>'pg_'
            UNION ALL
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname<>'information_schema' AND left(n.nspname,3)<>'pg_'
            UNION ALL
            SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND left(nspname,3)<>'pg_'
            UNION ALL
            SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'
            LIMIT 1
        `);
        if (objects.rowCount) throw new Error('The recovery target is not empty.');
        const decrypted = join(directory,'backup.dump');
        await decryptArchive(config,id,decrypted);
        const restore = utility(process.env.PG_RESTORE_BIN || 'pg_restore',
            ['--no-password','--single-transaction','--exit-on-error','--no-owner','--dbname='+dbEnvironment(config.restoreUrl).PGDATABASE,decrypted],
            config.restoreUrl);
        restore.child.stdout.resume();
        await restore.complete;
        const verified = await target.query(`SELECT
            (SELECT count(*)::int FROM schema_migrations) AS migrations,
            (SELECT count(*)::int FROM tenants) AS businesses,
            (SELECT count(*)::int FROM orders) AS orders,
            (SELECT count(*)::int FROM subscription_payment_receipts) AS payment_receipts,
            (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='orders'::regclass) AS order_rls`);
        if (!verified.rows[0].order_rls || !verified.rows[0].migrations) throw new Error('Recovery verification found an incomplete schema.');
        return verified.rows[0];
    } finally {
        await target.end().catch(() => {});
        await rm(directory,{ recursive:true,force:true });
    }
}

