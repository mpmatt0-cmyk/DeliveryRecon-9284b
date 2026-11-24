export type DeductionType =
  | 'MISSING_ITEM'
  | 'CANCELLED_AFTER_PREP'
  | 'PREP_TIME_PENALTY'
  | 'FALSE_STORE_CLOSED'
  | 'QUALITY_SUBJECTIVE'
  | 'OTHER'
  | 'REVERSAL_CREDIT';

export type MatchPass =
  | 'PASS_1_EXACT_REF'
  | 'PASS_2_SUBTOTAL_WINDOW'
  | 'PASS_3_ITEM_JACCARD'
  | 'STORE_ACTIVITY_PROOF'
  | 'UNMATCHED';

export type ClaimStatus =
  | 'AUTO_QUEUE'
  | 'MANUAL_REVIEW'
  | 'IGNORED'
  | 'SUBMITTED'
  | 'WON'
  | 'LOST';

export interface StoreConfig {
  id: string;
  name: string;
  pos_store_code: string;
  dd_merchant_store_id: string;
  iana_timezone: string;
  menu_markup_pct: number; // e.g., 0.15 for 15%
  inbound_email_address: string;
  client_slug?: string;
  disputes_2fa_email?: string;
  recovery_fee_pct?: number;
  created_at?: string;
}

export interface ParsedLineItem {
  quantity: number;
  raw_name: string;
  normalized_token: string; // e.g., '1x_wings_10pc'
  price_cents: number;
  modifiers: string[];
}

export interface ParsedPosCheck {
  pos_check_number: string;
  raw_external_ref: string | null;
  normalized_external_ref: string | null;
  ref_suffix_4: string | null;
  opened_at: string; // ISO UTC string
  closed_at: string | null;
  kds_bumped_at: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  is_voided: boolean;
  item_fingerprint: string[];
  items_json: ParsedLineItem[];
  raw_ej_block: string;
}

export interface StoredPosCheck extends ParsedPosCheck {
  id: string;
  store_id: string;
  ingestion_log_id: string | null;
}

export interface ParsedDeliveryOrder {
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB';
  external_order_id: string;
  normalized_order_id: string;
  order_suffix_4: string;
  order_created_at: string; // ISO UTC string
  cancelled_at: string | null;
  driver_arrived_at: string | null;
  dd_subtotal_cents: number;
  deduction_type: DeductionType;
  deduction_cents: number;
  dispute_deadline_at: string; // ISO UTC string (order_created_at + 14 days for DoorDash)
  customer_note: string | null;
  items_summary: string | null;
  item_fingerprint: string[];
  raw_csv_row: Record<string, string>;
}

export interface StoredDeliveryOrder extends ParsedDeliveryOrder {
  id: string;
  store_id: string;
  ingestion_log_id: string | null;
}

export interface ScoreReason {
  rule: string;
  points: number;
  detail: string;
}

export interface EvidencePacket {
  merchant_store_name: string;
  pos_store_code: string;
  dd_merchant_store_id: string;
  platform: string;
  external_order_id: string;
  deduction_type: DeductionType;
  deduction_cents: number;
  dd_subtotal_cents: number;
  expected_pos_subtotal_cents: number;
  matched_pos_subtotal_cents: number | null;
  menu_markup_pct: number;
  match_pass: MatchPass;
  match_confidence: number;
  dispute_score: number;
  jaccard_similarity: number | null;
  order_created_utc: string;
  order_created_local: string;
  pos_opened_utc: string | null;
  pos_opened_local: string | null;
  kds_bumped_utc: string | null;
  kds_bumped_local: string | null;
  driver_arrived_utc: string | null;
  driver_arrived_local: string | null;
  cancelled_utc: string | null;
  cancelled_local: string | null;
  adjacent_active_checks: Array<{
    pos_check_number: string;
    opened_local: string;
    subtotal_cents: number;
  }>;
  policy_citation: string;
  rebuttal_statement: string;
  raw_ej_block: string | null;
}

export interface ReconciledClaimResult {
  delivery_order_id: string;
  matched_pos_check_id: string | null;
  adjacent_pos_check_ids: string[];
  match_pass: MatchPass;
  match_confidence: number;
  dispute_score: number;
  status: ClaimStatus;
  score_breakdown: ScoreReason[];
  deduction_cents: number;
  verified_recovered_cents: number;
  rebuttal_text: string;
  evidence_packet_json: EvidencePacket;
}

export interface IngestionLogRecord {
  id: string;
  store_id: string;
  store_name?: string;
  source_type: 'EMAIL_WEBHOOK' | 'MANUAL_UPLOAD' | 'SEED_DEMO';
  file_type: 'POS_EJ' | 'DOORDASH_CSV' | 'UBEREATS_CSV' | 'GRUBHUB_CSV';
  filename: string;
  records_parsed: number;
  records_skipped: number;
  claims_reconciled: number;
  status: 'PROCESSED' | 'FAILED';
  error_summary: string | null;
  sender_email: string | null;
  recipient_email: string | null;
  created_at: string;
}

export interface Dispute2faCodeRecord {
  id: string;
  client_slug: string;
  recipient_email: string;
  sender_email: string;
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB';
  otp_code: string;
  subject: string | null;
  raw_email_snippet: string | null;
  consumed: boolean;
  expires_at: string;
  created_at: string;
}

export interface SubmissionJobRecord {
  id: string;
  claim_id: string;
  store_id: string;
  external_order_id?: string;
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB';
  execution_mode: 'PLAYWRIGHT_LIVE' | 'PLAYWRIGHT_DRY_RUN';
  status: 'QUEUED' | 'AWAITING_2FA' | 'SUBMITTED' | 'FAILED';
  portal_confirmation_id: string | null;
  used_2fa_code_id: string | null;
  step_logs: string[];
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RecoveryInvoiceRecord {
  id: string;
  store_id: string;
  store_name?: string;
  client_slug: string;
  stripe_invoice_id: string | null;
  stripe_mode: 'STRIPE_API' | 'LEDGER_DRY_RUN';
  period_label: string;
  won_claims_count: number;
  total_recovered_cents: number;
  fee_pct: number;
  invoice_amount_cents: number;
  claim_ids: string[];
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID';
  hosted_invoice_url: string | null;
  created_at: string;
}
