# ClaimPilot — Architectural Blueprint & Product Specification

> **Status:** Phase 1 MVP Specification (Approved Boundaries)
> **Domain:** B2B Restaurant Financial Operations & Delivery Chargeback Reconciliation
> **Stack:** Next.js (App Router, TypeScript strict), PostgreSQL (Raw SQL Migrations + Typed Query Helpers), Tailwind CSS + shadcn/ui, Vitest

---

## 1. Executive Summary & Core Business Problem

### Target Customer
Multi-unit regional restaurant franchisees and restaurant groups (3 to 50 locations) operating across high-volume delivery segments (pizza, wings, burger, fast-casual).

### The Problem
Restaurants lose **2% to 5% of gross third-party delivery revenue** (DoorDash, UberEats, Grubhub) to erroneous chargebacks, customer refund deductions, and operational penalties:
- **`MISSING_ITEM`**: False customer claims that items or modifiers were omitted.
- **`CANCELLED_AFTER_PREP`**: Orders cancelled after kitchen preparation and KDS bump completion.
- **`PREP_TIME_PENALTY`**: Unjustified driver wait/prep-time penalties where food was ready prior to driver arrival.
- **`FALSE_STORE_CLOSED`**: Penalties assessed for store closure while the store was actively ringing POS transactions.

### The Operational Bottleneck
- **Strict Dispute Windows:** DoorDash enforces a rolling **14-day dispute deadline** from order creation (UberEats allows ~30 days).
- **Manual Friction:** Cross-referencing weekly delivery payout CSVs against unstructured POS Electronic Journal (EJ) text logs and Kitchen Display System (KDS) bump timestamps takes hours per store each week, causing operators to forfeit thousands of dollars monthly.

### Value Proposition & Monetization Guardrails
**ClaimPilot** automates ingestion of POS transaction/KDS logs and delivery payout reports, reconciles orders at the line-item level using a deterministic 3-pass engine, scores each deduction for dispute winability (protecting merchant accounts from spam/ban flags), compiles a policy-cited evidence packet, and tracks verified payout recovery. Because monetization is tied to per-location SaaS fees and/or percentage of verified recovered revenue, **deterministic audit accuracy, zero false-positive dispute spam, and raw payload preservation** are non-negotiable.

---

## 2. Universal Ingestion Architecture (3-Tier Adapter Model)

To support fragmented legacy and cloud POS environments (Toast, Square, Clover, PAR Brink, NCR Aloha, Oracle Micros) without blocking onboarding on custom POS API integrations:

| Tier | Phase | Mechanism | Description |
| :--- | :--- | :--- | :--- |
| **Tier 1** | **Phase 1 (MVP)** | **Nightly File Drop & Inbound Email Webhook + Manual Uploader** | Every store receives a dedicated routing address (`store-{pos_store_code}@ingest.claimpilot.app`) for automated nightly POS EJ `.txt`/`.log` or `.csv` exports, paired with a drag-and-drop dashboard uploader for 14-day historical recovery audits and DoorDash payout CSVs. |
| **Tier 2** | Phase 2 | **Delivery Middleware Webhooks** | Normalized webhook ingestion from order-injection aggregators (Otter, ItsaCheckmate, Chowly, Deliverect). |
| **Tier 3** | Phase 3 | **Direct Cloud POS OAuth** | Native OAuth/REST connectors for Toast, Square, and PAR Brink. |

---

## 3. Core Technical Pipeline & Deterministic Business Rules

```
[Inbound Email / Upload]
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Stage 1: Normalization & Timezone Alignment              │
│ - Raw payload archival (raw_ej_block, raw_csv_row)       │
│ - Local POS time + Store IANA Timezone -> UTC TIMESTAMPTZ│
│ - Currency -> Integer Cents (INT)                        │
│ - Filter voids (is_voided = true) & $0.00 test checks    │
│ - Strip order ref prefixes (#, DD-, DOORDASH) & 4-char   │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Stage 2: 3-Pass Order Reconciliation (1-to-1 Claim Lock) │
│ - Pass 1: Exact Reference / Suffix Match (±2h) [98-100]  │
│ - Pass 2: Markup-Adjusted Subtotal (±2% / ±5¢, -5/+20m)  │
│ - Pass 3: Item-Fingerprint Jaccard Similarity (>= 0.60)  │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Stage 3: Dispute Eligibility & Confidence Gate (0-100)   │
│ - >= 80: AUTO_QUEUE                                      │
│ - 50-79: MANUAL_REVIEW                                   │
│ - < 50:  IGNORED (Anti-ban protection)                   │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Stage 4: Evidence Compilation & Recovery Lifecycle       │
│ - Policy-cited rebuttal + KDS timestamps + Verbatim EJ   │
│ - AUTO_QUEUE -> MANUAL_REVIEW -> SUBMITTED -> WON / LOST │
└──────────────────────────────────────────────────────────┘
```

### Stage 1: Normalization & Timezone Alignment
1. **UTC Timestamp Normalization:** All timestamps are persisted as PostgreSQL `TIMESTAMPTZ` in UTC. Unstructured POS EJ local timestamps are parsed against the store's explicit `iana_timezone` (e.g., `America/New_York`, `America/Chicago`), accurately handling Daylight Saving Time (DST) transitions.
2. **Integer Cent Currency:** All monetary figures (`subtotal_cents`, `tax_cents`, `deduction_cents`, `recovered_cents`) are stored and computed as integer cents (`INT`) to prevent IEEE-754 floating-point drift.
3. **Noise Filtering:** POS checks with `is_voided = true` or `subtotal_cents = 0` are excluded from active reconciliation candidates.
4. **Reference Tokenization:** Order reference strings strip leading symbols and platform prefixes (`#`, `DD-`, `DOORDASH`, whitespace) to produce both a `normalized_external_ref` and a 4-character suffix (`ref_suffix_4`).

### Stage 2: 3-Pass Order Reconciliation Engine (1-to-1 Claim Lock)
A POS check may only be bound to **one** primary delivery order (`matched_pos_check_id UNIQUE`). Once locked by a higher-confidence pass, it is excluded from subsequent passes:

- **Pass 1 — Exact Reference Match (Confidence `98–100`):**
  Matches normalized POS external reference code (or `ref_suffix_4`) against the DoorDash order identifier where `pos_opened_at` is within `±2 hours` of `dd_created_at`.
- **Pass 2 — Markup-Adjusted Subtotal + Tight Time Window (Confidence `85–95`):**
  Adjusts the DoorDash order subtotal by the store's configured `menu_markup_pct`:
  $$\text{expected\_pos\_cents} = \text{round}\left(\frac{\text{dd\_subtotal\_cents}}{1 + \text{menu\_markup\_pct}}\right)$$
  Matches unlocked POS checks within `±2%` of `expected_pos_cents` (or `±5 cents` when `menu_markup_pct = 0`) where `pos_opened_at` falls within `[dd_created_at - 5 minutes, dd_created_at + 20 minutes]`.
- **Pass 3 — Item-Fingerprint Disambiguation (Confidence `75–90`):**
  When multiple candidate checks collide in Pass 2 during rush hours, disambiguates using **Jaccard Similarity** (`>= 0.60`) over canonicalized item tokens (e.g., `['1x_wings_10pc', '1x_ranch']`).

### Stage 3: Dispute Eligibility & Confidence Gate (Anti-Ban Protection)
To protect merchant portals from automated spam flags, every reconciled deduction is scored `0–100`. Only claims scoring **`>= 80`** enter `AUTO_QUEUE`:

| Deduction Category | Verification Condition | Score | Initial Status |
| :--- | :--- | :---: | :--- |
| `CANCELLED_AFTER_PREP` | Matched POS check + KDS bump timestamp (`kds_bumped_at < cancelled_at`) proves food was prepared prior to cancellation. | **98** | `AUTO_QUEUE` |
| `FALSE_STORE_CLOSED` | POS EJ logs prove active checks were opened/closed at the same store within `±10 minutes` of the alleged closure timestamp. | **95** | `AUTO_QUEUE` |
| `PREP_TIME_PENALTY` | Matched POS check + KDS bump timestamp (`kds_bumped_at <= driver_arrived_at`) proves order was ready before driver arrival. | **92** | `AUTO_QUEUE` |
| `MISSING_ITEM` | Deduction `>= $15.00` (`1500` cents) + itemized POS EJ receipt block confirms full item count and required modifiers. | **80** | `AUTO_QUEUE` |
| Low-Dollar / Subjective / Weak | Deduction `< $5.00` (`500` cents), subjective quality complaints ("food cold"), or reconciliation confidence `< 75`. | **< 70** | `MANUAL_REVIEW` or `IGNORED` |

### Stage 4: Evidence Compilation & Recovery Lifecycle
- **Evidence Packet Generation:** Compiles a copy-ready, policy-cited rebuttal statement combining DoorDash order ID, timestamps in both UTC and store-local time, markup-adjusted subtotal reconciliation, KDS bump proof, and the verbatim `raw_ej_block` receipt excerpt.
- **Dispute Lifecycle State Machine:**
  `AUTO_QUEUE` / `MANUAL_REVIEW` / `IGNORED` $\rightarrow$ `SUBMITTED` $\rightarrow$ `WON` / `LOST`
- **Recovery Verification:** Subsequent DoorDash payout CSVs containing reversal/credit rows are reconciled against `SUBMITTED` claims to populate `verified_recovered_cents` and transition claims to `WON`.

---

## 4. Database Schema Blueprint (PostgreSQL Raw SQL)

All migrations live in `migrations/001_initial_schema.sql` using pure SQL without heavy ORMs. Raw source payloads are always persisted to allow retroactive re-parsing and reconciliation.

- **`stores`**:
  - `id` (UUID PK), `name`, `pos_store_code` (UNIQUE), `dd_Merchant_store_id`, `iana_timezone` (e.g., `America/Chicago`), `menu_markup_pct` (NUMERIC(5,4), default `0.1500`), `inbound_email_address`, `created_at`.
- **`ingestion_logs`**:
  - `id` (UUID PK), `store_id` (FK), `source_type` (`EMAIL_WEBHOOK` | `MANUAL_UPLOAD`), `file_type` (`POS_EJ` | `DOORDASH_CSV`), `filename`, `records_parsed`, `records_skipped`, `status`, `error_summary`, `raw_payload_hash`, `created_at`.
- **`pos_checks`**:
  - `id` (UUID PK), `store_id` (FK), `ingestion_log_id` (FK), `pos_check_number`, `raw_external_ref`, `normalized_external_ref`, `ref_suffix_4`, `opened_at` (`TIMESTAMPTZ`), `closed_at` (`TIMESTAMPTZ`), `kds_bumped_at` (`TIMESTAMPTZ`), `subtotal_cents` (`INT`), `tax_cents` (`INT`), `total_cents` (`INT`), `is_voided` (`BOOLEAN`), `item_fingerprint` (`TEXT[]`), `items_json` (`JSONB`), `raw_ej_block` (`TEXT` NOT NULL).
- **`delivery_orders`**:
  - `id` (UUID PK), `store_id` (FK), `ingestion_log_id` (FK), `platform` (`DOORDASH`), `external_order_id`, `normalized_order_id`, `order_suffix_4`, `order_created_at` (`TIMESTAMPTZ`), `cancelled_at` (`TIMESTAMPTZ`), `driver_arrived_at` (`TIMESTAMPTZ`), `dd_subtotal_cents` (`INT`), `deduction_type` (`MISSING_ITEM` | `CANCELLED_AFTER_PREP` | `PREP_TIME_PENALTY` | `FALSE_STORE_CLOSED` | `OTHER` | `REVERSAL_CREDIT`), `deduction_cents` (`INT`), `dispute_deadline_at` (`TIMESTAMPTZ`), `items_summary` (`TEXT`), `item_fingerprint` (`TEXT[]`), `raw_csv_row` (`JSONB` NOT NULL).
- **`claims`**:
  - `id` (UUID PK), `store_id` (FK), `delivery_order_id` (UUID UNIQUE FK), `matched_pos_check_id` (UUID UNIQUE FK NULLABLE — enforces 1-to-1 claim lock), `match_pass` (`PASS_1_EXACT_REF` | `PASS_2_SUBTOTAL_WINDOW` | `PASS_3_ITEM_JACCARD` | `NEARBY_ACTIVITY_PROOF` | `UNMATCHED`), `match_confidence` (`INT`), `dispute_score` (`INT`), `status` (`AUTO_QUEUE` | `MANUAL_REVIEW` | `IGNORED` | `SUBMITTED` | `WON` | `LOST`), `deduction_cents` (`INT`), `verified_recovered_cents` (`INT` DEFAULT 0), `rebuttal_text` (`TEXT`), `evidence_packet_json` (`JSONB`), `submitted_at` (`TIMESTAMPTZ`), `resolved_at` (`TIMESTAMPTZ`), `created_at`, `updated_at`.

---

## 5. System Boundaries: Phase 1 (MVP) vs. Phase 2

### Phase 1 — In Scope (Current Build)
1. **Multi-Store Configuration:** Store registry with `iana_timezone`, `pos_store_code`, `dd_merchant_store_id`, `menu_markup_pct`, and generated inbound email (`store-{pos_store_code}@ingest.claimpilot.app`).
2. **Parsers & Normalization Engine:**
   - Unstructured POS Electronic Journal (`.txt`/`.log`) parser extracting check numbers, delivery references, line items, KDS bump timestamps, voids, and verbatim `raw_ej_block` slices.
   - DoorDash Financial Payout CSV parser extracting order deductions, dispute deadlines (`order_created_at + 14 days`), and credit reversals.
3. **3-Pass Reconciliation, Confidence Gate & Rebuttal Compiler:**
   - Full implementation of Passes 1, 2, and 3 with 1-to-1 POS check locking, anti-ban confidence scoring, and policy-cited evidence packet generation.
4. **Operations Dashboard & Dispute Workflow UI:**
   - **KPI Strip:** Total Uncontested ($), Auto-Queued ($ & count), Expiring `< 72h` ($ & urgent badge), and Verified Recovered ($).
   - **Historical Audit Uploader:** Drag-and-drop ingestion panel for POS EJ logs and DoorDash payout CSVs with instant reconciliation feedback.
   - **Dispute Queue & Slide-Over Comparison Drawer:** Side-by-side view of DoorDash deduction metadata vs. matched POS EJ verbatim receipt block, match pass badge, confidence score breakdown, lifecycle status controls, and a **1-Click Copy Dispute Packet** button.
5. **Inbound Email Webhook & Ingestion Logs:**
   - `POST /api/webhooks/inbound-email` endpoint accepting multipart/JSON inbound email payloads addressed to `store-{pos_store_code}@ingest.claimpilot.app`, persisting audit trails in `ingestion_logs`.
6. **Automated Unit Test Suite (Vitest):**
   - Comprehensive unit tests for messy EJ log parsing, IANA timezone & DST boundary conversion, menu markup subtotal math, 3-pass matching & 1-to-1 lock guarantees, and confidence scoring rules.

### Phase 2 — Out of Scope for Phase 1 (Design Extensibility Only)
- Role-based 2FA email routing (`disputes+client@claimpilot.app`) and Playwright session-authenticated automated portal submission.
- UberEats and Grubhub payout CSV adapters (schema uses `platform` enum/column for clean extension).
- Tier 2 Delivery Middleware webhooks (Otter, Chowly, Deliverect) and Tier 3 Direct POS OAuth connectors.
- Stripe billing integration for automated percentage-of-recovery invoicing.
