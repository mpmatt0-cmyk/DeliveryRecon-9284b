export const MIGRATION_001_SQL = `
CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pos_store_code TEXT NOT NULL UNIQUE,
    dd_merchant_store_id TEXT NOT NULL,
    iana_timezone TEXT NOT NULL DEFAULT 'America/Chicago',
    menu_markup_pct NUMERIC(5, 4) NOT NULL DEFAULT 0.1500,
    inbound_email_address TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_logs (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('EMAIL_WEBHOOK', 'MANUAL_UPLOAD', 'SEED_DEMO')),
    file_type TEXT NOT NULL CHECK (file_type IN ('POS_EJ', 'DOORDASH_CSV', 'UBEREATS_CSV', 'GRUBHUB_CSV')),
    filename TEXT NOT NULL,
    records_parsed INT NOT NULL DEFAULT 0,
    records_skipped INT NOT NULL DEFAULT 0,
    claims_reconciled INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('PROCESSED', 'FAILED')),
    error_summary TEXT,
    sender_email TEXT,
    recipient_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_checks (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    ingestion_log_id TEXT REFERENCES ingestion_logs(id) ON DELETE SET NULL,
    pos_check_number TEXT NOT NULL,
    raw_external_ref TEXT,
    normalized_external_ref TEXT,
    ref_suffix_4 TEXT,
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    kds_bumped_at TIMESTAMPTZ,
    subtotal_cents INT NOT NULL CHECK (subtotal_cents >= 0),
    tax_cents INT NOT NULL DEFAULT 0,
    total_cents INT NOT NULL DEFAULT 0,
    is_voided BOOLEAN NOT NULL DEFAULT FALSE,
    item_fingerprint JSONB NOT NULL DEFAULT '[]'::jsonb,
    items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_ej_block TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, pos_check_number, opened_at)
);

CREATE INDEX IF NOT EXISTS idx_pos_checks_store_opened
    ON pos_checks(store_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_pos_checks_norm_ref
    ON pos_checks(store_id, normalized_external_ref);

CREATE TABLE IF NOT EXISTS delivery_orders (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    ingestion_log_id TEXT REFERENCES ingestion_logs(id) ON DELETE SET NULL,
    platform TEXT NOT NULL DEFAULT 'DOORDASH' CHECK (platform IN ('DOORDASH', 'UBEREATS', 'GRUBHUB')),
    external_order_id TEXT NOT NULL,
    normalized_order_id TEXT NOT NULL,
    order_suffix_4 TEXT NOT NULL,
    order_created_at TIMESTAMPTZ NOT NULL,
    cancelled_at TIMESTAMPTZ,
    driver_arrived_at TIMESTAMPTZ,
    dd_subtotal_cents INT NOT NULL DEFAULT 0,
    deduction_type TEXT NOT NULL CHECK (
        deduction_type IN (
            'MISSING_ITEM',
            'CANCELLED_AFTER_PREP',
            'PREP_TIME_PENALTY',
            'FALSE_STORE_CLOSED',
            'QUALITY_SUBJECTIVE',
            'OTHER',
            'REVERSAL_CREDIT'
        )
    ),
    deduction_cents INT NOT NULL,
    dispute_deadline_at TIMESTAMPTZ NOT NULL,
    customer_note TEXT,
    items_summary TEXT,
    item_fingerprint JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_csv_row JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, platform, external_order_id, deduction_type)
);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_store_created
    ON delivery_orders(store_id, order_created_at);

CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    delivery_order_id TEXT NOT NULL UNIQUE REFERENCES delivery_orders(id) ON DELETE CASCADE,
    matched_pos_check_id TEXT UNIQUE REFERENCES pos_checks(id) ON DELETE SET NULL,
    adjacent_pos_check_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    match_pass TEXT NOT NULL CHECK (
        match_pass IN (
            'PASS_1_EXACT_REF',
            'PASS_2_SUBTOTAL_WINDOW',
            'PASS_3_ITEM_JACCARD',
            'STORE_ACTIVITY_PROOF',
            'UNMATCHED'
        )
    ),
    match_confidence INT NOT NULL DEFAULT 0 CHECK (match_confidence BETWEEN 0 AND 100),
    dispute_score INT NOT NULL DEFAULT 0 CHECK (dispute_score BETWEEN 0 AND 100),
    status TEXT NOT NULL CHECK (
        status IN (
            'AUTO_QUEUE',
            'MANUAL_REVIEW',
            'IGNORED',
            'SUBMITTED',
            'WON',
            'LOST'
        )
    ),
    score_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
    deduction_cents INT NOT NULL CHECK (deduction_cents >= 0),
    verified_recovered_cents INT NOT NULL DEFAULT 0 CHECK (verified_recovered_cents >= 0),
    rebuttal_text TEXT NOT NULL,
    evidence_packet_json JSONB NOT NULL,
    submitted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_store_status
    ON claims(store_id, status);
`;

export const MIGRATION_002_SQL = `
ALTER TABLE stores
    ADD COLUMN IF NOT EXISTS client_slug TEXT DEFAULT 'windy-city',
    ADD COLUMN IF NOT EXISTS disputes_2fa_email TEXT DEFAULT 'disputes+windy-city@claimpilot.app',
    ADD COLUMN IF NOT EXISTS recovery_fee_pct NUMERIC(5, 4) DEFAULT 0.2000;

ALTER TABLE ingestion_logs DROP CONSTRAINT IF EXISTS ingestion_logs_file_type_check;
ALTER TABLE ingestion_logs
    ADD CONSTRAINT ingestion_logs_file_type_check
    CHECK (file_type IN ('POS_EJ', 'DOORDASH_CSV', 'UBEREATS_CSV', 'GRUBHUB_CSV'));

CREATE TABLE IF NOT EXISTS dispute_2fa_codes (
    id TEXT PRIMARY KEY,
    client_slug TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('DOORDASH', 'UBEREATS', 'GRUBHUB')),
    otp_code TEXT NOT NULL,
    subject TEXT,
    raw_email_snippet TEXT,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_2fa_lookup
    ON dispute_2fa_codes(client_slug, platform, consumed, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_jobs (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('DOORDASH', 'UBEREATS', 'GRUBHUB')),
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('PLAYWRIGHT_LIVE', 'PLAYWRIGHT_DRY_RUN')),
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'AWAITING_2FA', 'SUBMITTED', 'FAILED')),
    portal_confirmation_id TEXT,
    used_2fa_code_id TEXT REFERENCES dispute_2fa_codes(id) ON DELETE SET NULL,
    step_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_submission_jobs_claim
    ON submission_jobs(claim_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recovery_invoices (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    client_slug TEXT NOT NULL,
    stripe_invoice_id TEXT,
    stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('STRIPE_API', 'LEDGER_DRY_RUN')),
    period_label TEXT NOT NULL,
    won_claims_count INT NOT NULL DEFAULT 0,
    total_recovered_cents INT NOT NULL DEFAULT 0,
    fee_pct NUMERIC(5, 4) NOT NULL,
    invoice_amount_cents INT NOT NULL DEFAULT 0,
    claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'PAID', 'VOID')),
    hosted_invoice_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
