import { one, rows } from './db.js';

const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const bad = message => Object.assign(new Error(message), { status: 400 });

export async function branchSchedule(db, tenant, branch) {
    const location = await one(db, 'SELECT * FROM branches WHERE tenant_id=$1 AND id=$2', [tenant, branch]);
    if (!location) return null;
    const weekly = await rows(db, 'SELECT * FROM branch_weekly_hours WHERE tenant_id=$1 AND branch_id=$2 ORDER BY weekday',
        [tenant, branch]);
    const overrides = await rows(db, `
        SELECT day::text, label, closed, opens_at, closes_at FROM branch_date_overrides
        WHERE tenant_id=$1 AND branch_id=$2 ORDER BY day
    `, [tenant, branch]);
    const today = await one(db, `
        SELECT TO_CHAR(local.day, 'YYYY-MM-DD') AS date, COALESCE(o.closed, w.closed, false) AS closed,
            COALESCE(o.opens_at, w.opens_at, b.open_time) AS opens_at,
            COALESCE(o.closes_at, w.closes_at, b.close_time) AS closes_at, o.label
        FROM branches b CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.time_zone)::date AS day) local
        LEFT JOIN branch_date_overrides o ON o.tenant_id=b.tenant_id AND o.branch_id=b.id AND o.day=local.day
        LEFT JOIN branch_weekly_hours w ON w.tenant_id=b.tenant_id AND w.branch_id=b.id AND w.weekday=EXTRACT(ISODOW FROM local.day)
        WHERE b.tenant_id=$1 AND b.id=$2
    `, [tenant, branch]);
    return { branch: location, weekly, overrides, today };
}

function hours(row) {
    if (!row || typeof row.closed !== 'boolean') throw bad('Select opening hours or mark the location closed');
    if (row.closed) return [true, null, null];
    if (!clock.test(row.opens_at) || !clock.test(row.closes_at) || row.opens_at === row.closes_at) {
        throw bad('Enter distinct opening and closing times');
    }
    return [false, row.opens_at, row.closes_at];
}

function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function saveBranchSchedule(db, tenant, branch, input) {
    const { time_zone, weekly, overrides } = input;
    if (typeof time_zone !== 'string' || time_zone.length > 80 ||
        !Array.isArray(weekly) || weekly.length > 7 || !Array.isArray(overrides) || overrides.length > 366) {
        throw bad('Invalid branch schedule');
    }
    if (!await one(db, 'SELECT name FROM pg_timezone_names WHERE name=$1', [time_zone])) throw bad('Invalid branch time zone');
    const weekdays = new Set();
    const weeklyRows = weekly.map(row => {
        if (!row || !Number.isInteger(row.weekday) || row.weekday < 1 || row.weekday > 7 || weekdays.has(row.weekday)) {
            throw bad('Invalid or duplicate weekday');
        }
        weekdays.add(row.weekday);
        return [row.weekday, ...hours(row)];
    });
    const dates = new Set();
    const overrideRows = overrides.map(row => {
        if (!row || !validDay(row.day) || dates.has(row.day) ||
            typeof row.label !== 'string' || row.label.length > 120) throw bad('Invalid or duplicate override date');
        dates.add(row.day);
        return [row.day, row.label.trim(), ...hours(row)];
    });
    const result = await db.query('UPDATE branches SET time_zone=$3 WHERE tenant_id=$1 AND id=$2', [tenant, branch, time_zone]);
    if (!result.rowCount) return false;
    await db.query('DELETE FROM branch_weekly_hours WHERE tenant_id=$1 AND branch_id=$2', [tenant, branch]);
    await db.query('DELETE FROM branch_date_overrides WHERE tenant_id=$1 AND branch_id=$2', [tenant, branch]);
    for (const row of weeklyRows) {
        await db.query(`INSERT INTO branch_weekly_hours (tenant_id,branch_id,weekday,closed,opens_at,closes_at)
            VALUES ($1,$2,$3,$4,$5,$6)`, [tenant, branch, ...row]);
    }
    for (const row of overrideRows) {
        await db.query(`INSERT INTO branch_date_overrides (tenant_id,branch_id,day,label,closed,opens_at,closes_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenant, branch, ...row]);
    }
    return true;
}
