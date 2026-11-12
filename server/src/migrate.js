import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db.js';

const directory = new URL('../sql/', import.meta.url);
let client;
try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(601480231)');
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    const files = (await readdir(directory))
        .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
    const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows
        .map(row => row.filename));
    for (const filename of files) {
        if (applied.has(filename)) continue;
        const sql = await readFile(new URL(filename, directory), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    }
    await client.query('COMMIT');
    console.log('Schema migrated');
} catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', error.code || '', error.message);
    process.exitCode = 1;
} finally {
    client?.release();
    await pool.end();
}
