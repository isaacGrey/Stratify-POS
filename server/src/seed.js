import 'dotenv/config';import bcrypt from 'bcryptjs';import {pool} from './db.js';
const {SUPERADMIN_EMAIL:e,SUPERADMIN_PASSWORD:p}=process.env;
if(!e||!p||p.length<12){console.error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (12+ chars)');process.exit(1)}
await pool.query(
    `INSERT INTO users(name,email,password_hash,platform_admin) VALUES($1,$2,$3,true)
     ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, platform_admin=true`,
    ['Platform Administrator', e.trim().toLowerCase(), await bcrypt.hash(p,12)]
);
console.log('Super admin account ready');await pool.end();
