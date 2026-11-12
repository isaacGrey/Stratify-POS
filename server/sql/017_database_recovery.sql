CREATE TABLE backup_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled boolean NOT NULL DEFAULT false,
    frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly','monthly')),
    hour_utc smallint NOT NULL DEFAULT 18 CHECK (hour_utc BETWEEN 0 AND 23),
    weekday_utc smallint NOT NULL DEFAULT 0 CHECK (weekday_utc BETWEEN 0 AND 6),
    month_day_utc smallint NOT NULL DEFAULT 1 CHECK (month_day_utc BETWEEN 1 AND 28),
    retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
    changed_at timestamptz NOT NULL DEFAULT now(),
    worker_heartbeat timestamptz
);
INSERT INTO backup_settings (singleton) VALUES (true);

CREATE TABLE backup_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('backup','restore')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    source_backup_id uuid REFERENCES backup_jobs(id),
    schedule_slot timestamptz UNIQUE,
    requested_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    size_bytes bigint CHECK (size_bytes > 0),
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error text,
    notification_status text,
    delete_requested_at timestamptz,
    deleted_at timestamptz,
    CHECK ((kind='restore')=(source_backup_id IS NOT NULL))
);
CREATE INDEX backup_jobs_date_idx ON backup_jobs (created_at DESC,id);
CREATE INDEX backup_jobs_queued_idx ON backup_jobs (created_at) WHERE status='queued';
CREATE UNIQUE INDEX backup_single_restore_idx ON backup_jobs ((kind)) WHERE kind='restore' AND status IN ('queued','running');
REVOKE ALL ON backup_settings,backup_jobs FROM PUBLIC,coffee_saas_runtime;
