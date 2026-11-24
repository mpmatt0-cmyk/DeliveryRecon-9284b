-- =============================================================================
-- ClaimPilot Phase 2 — PostgreSQL Schema Migration (002_phase2_schema.sql)
-- =============================================================================
-- Adds:
-- 1. Role-based 2FA email routing (`disputes+{client}@claimpilot.app`) & OTP store
-- 2. Playwright session-authenticated portal submission job tracking
-- 3. Stripe % recovery billing & invoice ledger
-- =============================================================================

ALTER TABLE stores
    ADD COLUMN IF NOT EXISTS client_slug TEXT DEFAULT 'windy-city',
    ADD COLUMN IF NOT EXISTS disputes_2fa_email TEXT DEFAULT 'disputes+windy-city@claimpilot.app',
    ADD COLUMN IF NOT EXISTS recovery_fee_pct NUMERIC(5, 4) DEFAULT 0.2000;

-- Allow UBEREATS_CSV and GRUBHUB_CSV in ingestion_logs
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
