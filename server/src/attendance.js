import { one, rows } from './db.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

async function openShift(db, tenant, user) {
    return one(db, `
        SELECT a.*,
            (SELECT id FROM attendance_breaks b
             WHERE b.tenant_id=a.tenant_id AND b.attendance_id=a.id AND b.ended_at IS NULL) AS open_break
        FROM attendance a
        WHERE a.tenant_id=$1 AND a.user_id=$2 AND a.clock_out IS NULL
        ORDER BY a.clock_in DESC, a.id DESC LIMIT 1
    `, [tenant, user]);
}

export async function recordAttendance(db, tenant, user, action, branch, branchLimited = false) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 814736))', [tenant + ':' + user]);
    const shift = await openShift(db, tenant, user);
    if (action === 'clock-in') {
        if (shift) throw fail(409, 'Already clocked in');
        const schedule = await one(db, `
            WITH local AS (
                SELECT *, statement_timestamp() AT TIME ZONE time_zone AS local_time
                FROM work_schedules WHERE tenant_id=$1 AND user_id=$2
            ), matching AS (
                SELECT *, weekday=extract(isodow FROM local_time::date-1)
                    AND ends_at<starts_at AND local_time::time<ends_at AS overnight
                FROM local
            )
            SELECT branch_id,grace_minutes,
                (((local_time::date-CASE WHEN overnight THEN 1 ELSE 0 END)+starts_at) AT TIME ZONE time_zone) AS start
            FROM matching WHERE overnight OR weekday=extract(isodow FROM local_time)
            ORDER BY overnight DESC LIMIT 1
        `, [tenant, user]);
        if (branch && schedule?.branch_id && branch !== schedule.branch_id) {
            throw fail(409, 'Use the branch assigned in your work schedule');
        }
        const location = branch || schedule?.branch_id || null;
        if (branchLimited && !location) throw fail(400, 'Choose an assigned branch to clock in');
        if (location && !await one(db, 'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true', [tenant, location])) {
            throw fail(409, 'Clock-in branch is unavailable');
        }
        return one(db, `
            WITH stamp AS (SELECT clock_timestamp() AS moment)
            INSERT INTO attendance (tenant_id,user_id,branch_id,clock_in,managed_session,scheduled_start_at,late_minutes)
            SELECT $1,$2,$3,moment,true,$4::timestamptz,
                CASE WHEN moment > $4::timestamptz + $5::int * interval '1 minute'
                THEN ceil(extract(epoch FROM (moment - $4::timestamptz))/60)::int ELSE 0 END
            FROM stamp RETURNING *
        `, [tenant, user, location, schedule?.start ?? null, schedule?.grace_minutes ?? 0]);
    }
    if (!shift) throw fail(409, 'Clock in before recording attendance');
    if (action === 'clock-out') {
        if (shift.open_break) throw fail(409, 'End your break before clocking out');
        return one(db, 'UPDATE attendance SET clock_out=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [tenant, shift.id]);
    }
    if (action === 'break-start') {
        if (shift.open_break) throw fail(409, 'A break is already in progress');
        return one(db, 'INSERT INTO attendance_breaks (tenant_id,attendance_id) VALUES($1,$2) RETURNING *',
            [tenant, shift.id]);
    }
    if (!shift.open_break) throw fail(409, 'Start a break first');
    return one(db, 'UPDATE attendance_breaks SET ended_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [tenant, shift.open_break]);
}

export function attendanceStatus(db, tenant, user) {
    return openShift(db, tenant, user);
}

export function attendanceHistory(db, tenant, user) {
    return rows(db, `
        SELECT a.*, u.name, b.name AS branch,
            COALESCE(breaks.duration,0)::int AS break_seconds,
            CASE WHEN a.clock_out IS NOT NULL THEN
                greatest(0, extract(epoch FROM (a.clock_out-a.clock_in))::int-COALESCE(breaks.duration,0)::int)
            END AS work_seconds
        FROM attendance a JOIN users u ON u.id=a.user_id
        LEFT JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
        LEFT JOIN LATERAL (
            SELECT sum(extract(epoch FROM (ended_at-started_at))) AS duration
            FROM attendance_breaks WHERE tenant_id=a.tenant_id AND attendance_id=a.id
        ) breaks ON true
        WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.user_id=$2)
        ORDER BY a.clock_in DESC, a.id DESC LIMIT 100
    `, [tenant, user]);
}

export function attendanceSummary(db, tenant, user) {
    return rows(db, `
        SELECT a.user_id, u.name, count(*)::int AS shifts,
            count(*) FILTER (WHERE a.late_minutes > 0)::int AS late_shifts,
            COALESCE(sum(extract(epoch FROM (a.clock_out-a.clock_in)) - COALESCE(breaks.duration,0)),0)::bigint AS work_seconds
        FROM attendance a JOIN users u ON u.id=a.user_id
        LEFT JOIN LATERAL (
            SELECT sum(extract(epoch FROM (ended_at-started_at))) AS duration
            FROM attendance_breaks WHERE tenant_id=a.tenant_id AND attendance_id=a.id
        ) breaks ON true
        WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.user_id=$2) AND a.clock_in >= now() - interval '30 days'
        GROUP BY a.user_id,u.name ORDER BY u.name
    `, [tenant, user]);
}
