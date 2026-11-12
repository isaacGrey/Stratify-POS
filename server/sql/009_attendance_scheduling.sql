ALTER TABLE attendance
    ADD COLUMN IF NOT EXISTS managed_session boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
    ADD COLUMN IF NOT EXISTS late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0);

-- Legacy open records remain intact. Every new session uses the constraint.
CREATE UNIQUE INDEX attendance_managed_open_idx
    ON attendance (tenant_id, user_id) WHERE managed_session AND clock_out IS NULL;
CREATE UNIQUE INDEX attendance_tenant_id_idx ON attendance (tenant_id, id);
CREATE INDEX attendance_user_date_idx ON attendance (tenant_id, user_id, clock_in DESC);

CREATE TABLE attendance_breaks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    attendance_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz CHECK (ended_at >= started_at),
    FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendance(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX attendance_open_break_idx
    ON attendance_breaks (tenant_id, attendance_id) WHERE ended_at IS NULL;
CREATE INDEX attendance_break_history_idx ON attendance_breaks (tenant_id, attendance_id, started_at);

CREATE TABLE work_schedules (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    branch_id uuid,
    starts_at time NOT NULL,
    ends_at time NOT NULL CHECK (ends_at > starts_at),
    time_zone text NOT NULL,
    grace_minutes integer NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 180),
    PRIMARY KEY (tenant_id,user_id,weekday),
    FOREIGN KEY (tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);

DO $$ DECLARE relation text; BEGIN
    FOREACH relation IN ARRAY ARRAY['attendance_breaks', 'work_schedules'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('CREATE POLICY tenant_scope ON %I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', relation);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO coffee_saas_runtime', relation);
    END LOOP;
END $$;

GRANT INSERT (name,email,password_hash) ON users TO coffee_saas_runtime;
