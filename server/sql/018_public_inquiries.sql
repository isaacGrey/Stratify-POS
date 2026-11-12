CREATE TABLE public_inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL,
    business text NOT NULL DEFAULT '',
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);
CREATE INDEX public_inquiries_date_idx ON public_inquiries (created_at DESC,id);
REVOKE ALL ON public_inquiries FROM PUBLIC,coffee_saas_runtime;
