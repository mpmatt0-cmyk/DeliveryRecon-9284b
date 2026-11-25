import crypto from 'crypto';
import { getDb } from './db';
import {
  readCloudJournal,
  recordStoreInCloudJournal,
  recordUploadInCloudJournal,
} from './cloud-journal';
import { parsePosElectronicJournal } from './parsers/pos-ej-parser';
import { parseDoorDashPayoutCsv } from './parsers/doordash-csv-parser';
import { parseUberEatsPayoutCsv } from './parsers/ubereats-csv-parser';
import { parseGrubhubPayoutCsv } from './parsers/grubhub-csv-parser';
import { reconcileOrdersAndScoreClaims } from './reconciliation';
import {
  ClaimStatus,
  DeductionType,
  EvidencePacket,
  IngestionLogRecord,
  MatchPass,
  ParsedLineItem,
  ScoreReason,
  StoreConfig,
  StoredDeliveryOrder,
  StoredPosCheck,
} from './types';

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export interface ClaimRowView {
  id: string;
  store_id: string;
  store_name: string;
  pos_store_code: string;
  iana_timezone: string;
  menu_markup_pct: number;
  delivery_order_id: string;
  external_order_id: string;
  platform: string;
  order_created_at: string;
  cancelled_at: string | null;
  driver_arrived_at: string | null;
  dd_subtotal_cents: number;
  deduction_type: DeductionType;
  deduction_cents: number;
  dispute_deadline_at: string;
  customer_note: string | null;
  items_summary: string | null;
  raw_csv_row: Record<string, string>;
  matched_pos_check_id: string | null;
  pos_check_number: string | null;
  pos_opened_at: string | null;
  pos_kds_bumped_at: string | null;
  pos_subtotal_cents: number | null;
  pos_raw_ej_block: string | null;
  match_pass: MatchPass;
  match_confidence: number;
  dispute_score: number;
  status: ClaimStatus;
  score_breakdown: ScoreReason[];
  verified_recovered_cents: number;
  rebuttal_text: string;
  evidence_packet_json: EvidencePacket;
  submitted_at: string | null;
  resolved_at: string | null;
}

const globalForSeed = globalThis as unknown as {
  claimPilotSeedPromise?: Promise<void>;
  claimPilotAppliedUploads?: Set<string>;
};

export async function ensureSeeded(): Promise<void> {
  if (!globalForSeed.claimPilotSeedPromise) {
    globalForSeed.claimPilotSeedPromise = runSeedOnce().catch((err) => {
      globalForSeed.claimPilotSeedPromise = undefined;
      throw err;
    });
  }
  await globalForSeed.claimPilotSeedPromise;
  await syncFromCloudJournal();
}

async function syncFromCloudJournal(): Promise<void> {
  const journal = await readCloudJournal();
  if (!journal) return;

  const db = await getDb();
  if (!globalForSeed.claimPilotAppliedUploads) {
    globalForSeed.claimPilotAppliedUploads = new Set<string>();
  }

  for (const s of journal.stores) {
    const code = s.pos_store_code.trim().toUpperCase();
    const inboundEmail = `store-${code.toLowerCase()}@ingest.claimpilot.app`;
    await db.query(
      `INSERT INTO stores (id, name, pos_store_code, dd_merchant_store_id, iana_timezone, menu_markup_pct, inbound_email_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pos_store_code) DO UPDATE SET
         name = EXCLUDED.name,
         dd_merchant_store_id = EXCLUDED.dd_merchant_store_id,
         iana_timezone = EXCLUDED.iana_timezone,
         menu_markup_pct = EXCLUDED.menu_markup_pct,
         inbound_email_address = EXCLUDED.inbound_email_address`,
      [
        s.id,
        s.name.trim(),
        code,
        s.dd_merchant_store_id.trim(),
        s.iana_timezone.trim(),
        s.menu_markup_pct,
        inboundEmail,
      ]
    );
  }

  for (const u of journal.uploads) {
    if (globalForSeed.claimPilotAppliedUploads.has(u.id)) continue;
    globalForSeed.claimPilotAppliedUploads.add(u.id);

    const storeRes = await db.query<{
      id: string;
      name: string;
      pos_store_code: string;
      dd_merchant_store_id: string;
      iana_timezone: string;
      menu_markup_pct: string | number;
      inbound_email_address: string;
    }>(`SELECT * FROM stores WHERE UPPER(pos_store_code) = $1 LIMIT 1`, [
      u.store_pos_code.toUpperCase(),
    ]);
    if (storeRes.rows.length === 0) continue;
    const rawStore = storeRes.rows[0];
    const storeObj: StoreConfig = {
      ...rawStore,
      menu_markup_pct: Number(rawStore.menu_markup_pct),
    };

    if (u.fileType === 'POS_EJ') {
      await ingestPosEjForStore(
        storeObj.id,
        u.filename,
        u.content,
        u.sourceType,
        undefined,
        storeObj,
        true
      );
    } else {
      const platform =
        u.fileType === 'UBEREATS_CSV'
          ? 'UBEREATS'
          : u.fileType === 'GRUBHUB_CSV'
            ? 'GRUBHUB'
            : 'DOORDASH';
      await ingestPlatformCsvForStore(
        storeObj.id,
        platform,
        u.filename,
        u.content,
        u.sourceType,
        undefined,
        storeObj,
        true
      );
    }
  }
}

async function runSeedOnce(): Promise<void> {
  const db = await getDb();
  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt FROM stores`
  );
  const count = Number(countRes.rows[0]?.cnt ?? 0);
  if (count > 0) return;

  // Seed 3 multi-unit regional restaurant franchisee locations across timezones
  const demoStores: StoreConfig[] = [
    {
      id: 'store_chi_104',
      name: 'Windy City Wings #104 (Lincoln Park)',
      pos_store_code: 'CHI-104',
      dd_merchant_store_id: 'DD-M-992104',
      iana_timezone: 'America/Chicago',
      menu_markup_pct: 0.15,
      inbound_email_address: 'store-chi-104@ingest.claimpilot.app',
    },
    {
      id: 'store_atl_208',
      name: 'Peachtree Brick Oven Pizza #208 (Midtown)',
      pos_store_code: 'ATL-208',
      dd_merchant_store_id: 'DD-M-774208',
      iana_timezone: 'America/New_York',
      menu_markup_pct: 0.18,
      inbound_email_address: 'store-atl-208@ingest.claimpilot.app',
    },
    {
      id: 'store_den_312',
      name: 'Mile High Smashburger #312 (LoDo)',
      pos_store_code: 'DEN-312',
      dd_merchant_store_id: 'DD-M-551312',
      iana_timezone: 'America/Denver',
      menu_markup_pct: 0.12,
      inbound_email_address: 'store-den-312@ingest.claimpilot.app',
    },
  ];

  for (const s of demoStores) {
    await db.query(
      `INSERT INTO stores (id, name, pos_store_code, dd_merchant_store_id, iana_timezone, menu_markup_pct, inbound_email_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pos_store_code) DO NOTHING`,
      [
        s.id,
        s.name,
        s.pos_store_code,
        s.dd_merchant_store_id,
        s.iana_timezone,
        s.menu_markup_pct,
        s.inbound_email_address,
      ]
    );
  }

  // Seed realistic POS EJ Log + DoorDash Payout CSV for Store #104 (America/Chicago)
  // Using dates relative to current clock so "< 72h Expiring" KPI is actively demonstrated
  const nowMs = Date.now();
  const twelveDaysAgoLocal = formatLocalForSeed(
    new Date(nowMs - 12.4 * 24 * 60 * 60 * 1000),
    'America/Chicago'
  ); // Expiring in ~38 hours (< 72h!)
  const fiveDaysAgoLocal = formatLocalForSeed(
    new Date(nowMs - 5 * 24 * 60 * 60 * 1000),
    'America/Chicago'
  );
  const threeDaysAgoLocal = formatLocalForSeed(
    new Date(nowMs - 3 * 24 * 60 * 60 * 1000),
    'America/Chicago'
  );

  const seedEjText = [
    `==========================================`,
    `CHK# 8101 | EXT REF: DOORDASH #DD-9041A8B2`,
    `OPENED: ${twelveDaysAgoLocal.date} 18:10:00`,
    `KDS BUMPED: ${twelveDaysAgoLocal.date} 18:22:10`,
    `CLOSED: ${twelveDaysAgoLocal.date} 18:24:00`,
    `2x Wings 10pc                 $29.98`,
    `  + Traditional Hot Buffalo`,
    `  + Extra Side Ranch`,
    `1x Loaded Cheese Fries        $8.02`,
    `SUBTOTAL:                     $38.00`,
    `TAX:                          $3.89`,
    `TOTAL:                        $41.89`,
    `==========================================`,
    `CHK# 8102`,
    `OPENED: ${fiveDaysAgoLocal.date} 19:04:00`,
    `KDS BUMPED: ${fiveDaysAgoLocal.date} 19:13:20`,
    `CLOSED: ${fiveDaysAgoLocal.date} 19:15:00`,
    `1x Family Wing Bundle 30pc    $34.00`,
    `  + Garlic Parmesan`,
    `  + 2x Bleu Cheese`,
    `1x Onion Rings                $6.00`,
    `SUBTOTAL:                     $40.00`,
    `TAX:                          $4.10`,
    `TOTAL:                        $44.10`,
    `==========================================`,
    `CHK# 8103`,
    `OPENED: ${threeDaysAgoLocal.date} 20:03:00`,
    `KDS BUMPED: ${threeDaysAgoLocal.date} 20:14:00`,
    `CLOSED: ${threeDaysAgoLocal.date} 20:15:30`,
    `2x Pepperoni Pizza            $28.00`,
    `SUBTOTAL:                     $28.00`,
    `TAX:                          $2.87`,
    `TOTAL:                        $30.87`,
    `==========================================`,
    `CHK# 8104`,
    `OPENED: ${threeDaysAgoLocal.date} 20:04:30`,
    `KDS BUMPED: ${threeDaysAgoLocal.date} 20:15:45`,
    `CLOSED: ${threeDaysAgoLocal.date} 20:17:00`,
    `1x Wings 10pc                 $16.00`,
    `  + Side Ranch`,
    `1x Chicken Tenders 6pc        $12.00`,
    `  + Honey Mustard`,
    `SUBTOTAL:                     $28.00`,
    `TAX:                          $2.87`,
    `TOTAL:                        $30.87`,
    `==========================================`,
    `CHK# 8105 | EXT REF: DD-VOID991`,
    `OPENED: ${threeDaysAgoLocal.date} 20:08:00`,
    `*** VOID CHECK ***`,
    `1x Wings 10pc                 $16.00`,
    `SUBTOTAL:                     $16.00`,
    `TOTAL:                        $16.00`,
    `==========================================`,
  ].join('\n');

  const seedDdCsv = [
    `order_id,order_created_at,cancelled_at,driver_arrived_at,subtotal,error_charge,transaction_type,items,customer_note`,
    `DD-9041A8B2,${twelveDaysAgoLocal.date} 18:08:00,${twelveDaysAgoLocal.date} 18:27:00,,$43.70,-$43.70,Cancelled After Prep,"2x Wings 10pc, 1x Ranch, 1x Loaded Cheese Fries",Customer cancelled order 5 mins after KDS bump`,
    `DD-7731C4D9,${fiveDaysAgoLocal.date} 19:00:00,,${fiveDaysAgoLocal.date} 19:19:30,$46.00,-$14.50,Prep Time / Driver Wait Penalty,"1x Family Wing Bundle 30pc, 1x Onion Rings",Avoidable Dasher wait fee assessed`,
    `DD-6612E9F1,${threeDaysAgoLocal.date} 20:01:00,,,$32.20,-$19.50,Missing Item,"1x Wings 10pc, 1x Ranch, 1x Chicken Tenders",Customer reported 10pc wings and ranch missing`,
    `DD-5509CLOSED,${threeDaysAgoLocal.date} 20:09:00,,,$0.00,-$25.00,Store Closed Penalty,"",Dasher reported store closed prior to closing hours`,
    `DD-3318COLD,${threeDaysAgoLocal.date} 21:15:00,,,$24.00,-$4.25,Food Quality Complaint,"1x Fries",Customer said fries were cold`,
  ].join('\n');

  await ingestPosEjForStore(
    'store_chi_104',
    'CHI-104_nightly_ej.log',
    seedEjText,
    'SEED_DEMO',
    undefined,
    demoStores[0]
  );
  await ingestDoorDashCsvForStore(
    'store_chi_104',
    'DoorDash_Payout_CHI-104.csv',
    seedDdCsv,
    'SEED_DEMO',
    undefined,
    demoStores[0]
  );

  // Mark one additional historical claim as WON ($36.80 verified recovered) so Verified Recovered KPI is live out of the box
  const wonOrderId = makeId('ord');
  const wonClaimId = makeId('clm');
  await db.query(
    `INSERT INTO delivery_orders (
      id, store_id, platform, external_order_id, normalized_order_id, order_suffix_4,
      order_created_at, dd_subtotal_cents, deduction_type, deduction_cents,
      dispute_deadline_at, customer_note, items_summary, item_fingerprint, raw_csv_row
    ) VALUES ($1, $2, 'DOORDASH', 'DD-4401WON8', '4401WON8', 'WON8', $3, 3680, 'CANCELLED_AFTER_PREP', 3680, $4, 'Order cancelled after KDS bump', '2x Wings 10pc, 1x Fries', '["2x_10pc_wings","1x_fries"]'::jsonb, '{"order_id":"DD-4401WON8","status":"CREDITED"}'::jsonb)
    ON CONFLICT (store_id, platform, external_order_id, deduction_type) DO NOTHING`,
    [
      wonOrderId,
      'store_chi_104',
      new Date(nowMs - 9 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(nowMs + 5 * 24 * 60 * 60 * 1000).toISOString(),
    ]
  );

  await db.query(
    `INSERT INTO claims (
      id, store_id, delivery_order_id, match_pass, match_confidence, dispute_score,
      status, score_breakdown, deduction_cents, verified_recovered_cents,
      rebuttal_text, evidence_packet_json, submitted_at, resolved_at
    ) VALUES ($1, 'store_chi_104', $2, 'PASS_1_EXACT_REF', 100, 98, 'WON', $3::jsonb, 3680, 3680, $4, $5::jsonb, $6, $7)
    ON CONFLICT (delivery_order_id) DO NOTHING`,
    [
      wonClaimId,
      wonOrderId,
      JSON.stringify([
        {
          rule: 'KDS_BUMP_BEFORE_CANCELLATION',
          points: 98,
          detail: 'Verified KDS bump completed 6m 15s prior to cancellation; payout reversal credit confirmed.',
        },
      ]),
      '=== CLAIMPILOT VERIFIED DISPUTE EVIDENCE PACKET ===\nOrder DD-4401WON8 — Verified Payout Credit Reversal ($36.80) confirmed in weekly DoorDash settlement.',
      JSON.stringify({
        merchant_store_name: 'Windy City Wings #104 (Lincoln Park)',
        pos_store_code: 'CHI-104',
        dd_merchant_store_id: 'DD-M-992104',
        platform: 'DOORDASH',
        external_order_id: 'DD-4401WON8',
        deduction_type: 'CANCELLED_AFTER_PREP',
        deduction_cents: 3680,
        dd_subtotal_cents: 3680,
        expected_pos_subtotal_cents: 3200,
        matched_pos_subtotal_cents: 3200,
        menu_markup_pct: 0.15,
        match_pass: 'PASS_1_EXACT_REF',
        match_confidence: 100,
        dispute_score: 98,
        jaccard_similarity: 1,
        order_created_utc: new Date(nowMs - 9 * 24 * 60 * 60 * 1000).toISOString(),
        order_created_local: `${fiveDaysAgoLocal.date} 17:40:00 CST`,
        pos_opened_utc: null,
        pos_opened_local: `${fiveDaysAgoLocal.date} 17:41:00 CST`,
        kds_bumped_utc: null,
        kds_bumped_local: `${fiveDaysAgoLocal.date} 17:52:00 CST`,
        driver_arrived_utc: null,
        driver_arrived_local: null,
        cancelled_utc: null,
        cancelled_local: `${fiveDaysAgoLocal.date} 17:58:15 CST`,
        adjacent_active_checks: [],
        policy_citation:
          'DoorDash Merchant Payment Policy §4.2 (Cancelled Orders After Kitchen Preparation Commencement)',
        rebuttal_statement:
          'Verified payout credit ($36.80) reconciled against DoorDash Order DD-4401WON8.',
        raw_ej_block:
          'CHK# 7988 | EXT REF: DOORDASH #DD-4401WON8\n2x Wings 10pc $26.00\n1x Fries $6.00\nSUBTOTAL: $32.00',
      }),
      new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString(),
    ]
  );
}

function formatLocalForSeed(date: Date, ianaTimezone: string): { date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return { date: parts };
}

export async function listStores(): Promise<StoreConfig[]> {
  await ensureSeeded();
  const db = await getDb();
  const res = await db.query<{
    id: string;
    name: string;
    pos_store_code: string;
    dd_merchant_store_id: string;
    iana_timezone: string;
    menu_markup_pct: string | number;
    inbound_email_address: string;
    created_at: string;
  }>(`SELECT * FROM stores ORDER BY created_at ASC`);

  return res.rows.map((r) => ({
    ...r,
    menu_markup_pct: Number(r.menu_markup_pct),
  }));
}

export async function getStoreById(storeId: string): Promise<StoreConfig | null> {
  await ensureSeeded();
  const db = await getDb();
  const res = await db.query<{
    id: string;
    name: string;
    pos_store_code: string;
    dd_merchant_store_id: string;
    iana_timezone: string;
    menu_markup_pct: string | number;
    inbound_email_address: string;
  }>(`SELECT * FROM stores WHERE id = $1`, [storeId]);

  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    ...r,
    menu_markup_pct: Number(r.menu_markup_pct),
  };
}

export async function getStoreByPosCodeOrEmail(
  codeOrEmail: string
): Promise<StoreConfig | null> {
  await ensureSeeded();
  const db = await getDb();
  const cleaned = codeOrEmail.trim().toLowerCase();

  // Extract store-{pos_store_code}@ingest.claimpilot.app if email format
  const emailMatch = cleaned.match(/store-([a-z0-9_-]+)@/i);
  const extractedCode = emailMatch ? emailMatch[1].toUpperCase() : cleaned.toUpperCase();

  const res = await db.query<{
    id: string;
    name: string;
    pos_store_code: string;
    dd_merchant_store_id: string;
    iana_timezone: string;
    menu_markup_pct: string | number;
    inbound_email_address: string;
  }>(
    `SELECT * FROM stores
     WHERE UPPER(pos_store_code) = $1
        OR LOWER(inbound_email_address) = $2
     LIMIT 1`,
    [extractedCode, cleaned]
  );

  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    ...r,
    menu_markup_pct: Number(r.menu_markup_pct),
  };
}

export async function createOrUpdateStore(input: {
  id?: string;
  name: string;
  pos_store_code: string;
  dd_merchant_store_id: string;
  iana_timezone: string;
  menu_markup_pct: number;
}): Promise<StoreConfig> {
  await ensureSeeded();
  const db = await getDb();
  const code = input.pos_store_code.trim().toUpperCase();
  const inboundEmail = `store-${code.toLowerCase()}@ingest.claimpilot.app`;
  const id = input.id || makeId('store');

  await db.query(
    `INSERT INTO stores (id, name, pos_store_code, dd_merchant_store_id, iana_timezone, menu_markup_pct, inbound_email_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (pos_store_code) DO UPDATE SET
       name = EXCLUDED.name,
       dd_merchant_store_id = EXCLUDED.dd_merchant_store_id,
       iana_timezone = EXCLUDED.iana_timezone,
       menu_markup_pct = EXCLUDED.menu_markup_pct,
       inbound_email_address = EXCLUDED.inbound_email_address`,
    [
      id,
      input.name.trim(),
      code,
      input.dd_merchant_store_id.trim(),
      input.iana_timezone.trim(),
      input.menu_markup_pct,
      inboundEmail,
    ]
  );

  const store = await getStoreByPosCodeOrEmail(code);
  if (!store) throw new Error('Failed to persist store configuration');
  await recordStoreInCloudJournal({
    id: store.id,
    name: store.name,
    pos_store_code: store.pos_store_code,
    dd_merchant_store_id: store.dd_merchant_store_id,
    iana_timezone: store.iana_timezone,
    menu_markup_pct: store.menu_markup_pct,
  });
  await runStoreReconciliation(store.id, store);
  return store;
}

/**
 * Ingests a POS Electronic Journal (.txt/.log) file for a store, archives raw_ej_block,
 * logs to ingestion_logs, and triggers the 3-Pass Reconciliation Engine.
 */
export async function ingestPosEjForStore(
  storeId: string,
  filename: string,
  rawText: string,
  sourceType: 'EMAIL_WEBHOOK' | 'MANUAL_UPLOAD' | 'SEED_DEMO',
  emailMeta?: { sender?: string; recipient?: string },
  preloadedStore?: StoreConfig,
  skipJournalRecord = false
): Promise<{
  logId: string;
  recordsParsed: number;
  recordsSkipped: number;
  claimsReconciled: number;
}> {
  const db = await getDb();
  const store = preloadedStore ?? (await getStoreById(storeId));
  if (!store) throw new Error(`Store not found: ${storeId}`);

  const logId = makeId('ing');
  if (sourceType !== 'SEED_DEMO' && !skipJournalRecord) {
    if (!globalForSeed.claimPilotAppliedUploads) {
      globalForSeed.claimPilotAppliedUploads = new Set<string>();
    }
    globalForSeed.claimPilotAppliedUploads.add(logId);
    await recordUploadInCloudJournal({
      id: logId,
      store_pos_code: store.pos_store_code,
      fileType: 'POS_EJ',
      filename,
      content: rawText,
      sourceType,
      createdAt: new Date().toISOString(),
    });
  }
  const parsed = parsePosElectronicJournal(rawText, store.iana_timezone);

  await db.query(
    `INSERT INTO ingestion_logs (
      id, store_id, source_type, file_type, filename,
      records_parsed, records_skipped, claims_reconciled, status,
      sender_email, recipient_email
    ) VALUES ($1, $2, $3, 'POS_EJ', $4, $5, $6, 0, 'PROCESSED', $7, $8)`,
    [
      logId,
      store.id,
      sourceType,
      filename,
      parsed.validChecks.length,
      parsed.skippedVoidOrZeroChecks.length,
      emailMeta?.sender ?? null,
      emailMeta?.recipient ?? store.inbound_email_address,
    ]
  );

  // Persist both valid and voided checks (so raw_ej_block audit is 100% complete, while reconciliation filters voids)
  const allChecks = [...parsed.validChecks, ...parsed.skippedVoidOrZeroChecks];
  for (const chk of allChecks) {
    await db.query(
      `INSERT INTO pos_checks (
        id, store_id, ingestion_log_id, pos_check_number,
        raw_external_ref, normalized_external_ref, ref_suffix_4,
        opened_at, closed_at, kds_bumped_at,
        subtotal_cents, tax_cents, total_cents, is_voided,
        item_fingerprint, items_json, raw_ej_block
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17)
      ON CONFLICT (store_id, pos_check_number, opened_at) DO UPDATE SET
        raw_external_ref = EXCLUDED.raw_external_ref,
        normalized_external_ref = EXCLUDED.normalized_external_ref,
        ref_suffix_4 = EXCLUDED.ref_suffix_4,
        kds_bumped_at = EXCLUDED.kds_bumped_at,
        subtotal_cents = EXCLUDED.subtotal_cents,
        is_voided = EXCLUDED.is_voided,
        item_fingerprint = EXCLUDED.item_fingerprint,
        items_json = EXCLUDED.items_json,
        raw_ej_block = EXCLUDED.raw_ej_block`,
      [
        makeId('chk'),
        store.id,
        logId,
        chk.pos_check_number,
        chk.raw_external_ref,
        chk.normalized_external_ref,
        chk.ref_suffix_4,
        chk.opened_at,
        chk.closed_at,
        chk.kds_bumped_at,
        chk.subtotal_cents,
        chk.tax_cents,
        chk.total_cents,
        chk.is_voided,
        JSON.stringify(chk.item_fingerprint),
        JSON.stringify(chk.items_json),
        chk.raw_ej_block,
      ]
    );
  }

  const claimsReconciled = await runStoreReconciliation(store.id, store);
  await db.query(`UPDATE ingestion_logs SET claims_reconciled = $1 WHERE id = $2`, [
    claimsReconciled,
    logId,
  ]);

  return {
    logId,
    recordsParsed: parsed.validChecks.length,
    recordsSkipped: parsed.skippedVoidOrZeroChecks.length,
    claimsReconciled,
  };
}

/**
 * Ingests a DoorDash Financial Payout CSV for a store, reconciles chargebacks & credit reversals,
 * and updates claims.
 */
export async function ingestDoorDashCsvForStore(
  storeId: string,
  filename: string,
  csvText: string,
  sourceType: 'EMAIL_WEBHOOK' | 'MANUAL_UPLOAD' | 'SEED_DEMO',
  emailMeta?: { sender?: string; recipient?: string },
  preloadedStore?: StoreConfig
) {
  return ingestPlatformCsvForStore(
    storeId,
    'DOORDASH',
    filename,
    csvText,
    sourceType,
    emailMeta,
    preloadedStore
  );
}

/**
 * Unified Phase 2 Multi-Platform Payout CSV Ingestion (`DOORDASH`, `UBEREATS`, `GRUBHUB`)
 */
export async function ingestPlatformCsvForStore(
  storeId: string,
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB',
  filename: string,
  csvText: string,
  sourceType: 'EMAIL_WEBHOOK' | 'MANUAL_UPLOAD' | 'SEED_DEMO',
  emailMeta?: { sender?: string; recipient?: string },
  preloadedStore?: StoreConfig,
  skipJournalRecord = false
): Promise<{
  logId: string;
  recordsParsed: number;
  recordsSkipped: number;
  claimsReconciled: number;
  reversalsApplied: number;
}> {
  const db = await getDb();
  const store = preloadedStore ?? (await getStoreById(storeId));
  if (!store) throw new Error(`Store not found: ${storeId}`);

  const logId = makeId('ing');
  const parsed =
    platform === 'UBEREATS'
      ? parseUberEatsPayoutCsv(csvText, store.iana_timezone)
      : platform === 'GRUBHUB'
        ? parseGrubhubPayoutCsv(csvText, store.iana_timezone)
        : parseDoorDashPayoutCsv(csvText, store.iana_timezone);

  const fileType =
    platform === 'UBEREATS'
      ? 'UBEREATS_CSV'
      : platform === 'GRUBHUB'
        ? 'GRUBHUB_CSV'
        : 'DOORDASH_CSV';

  if (sourceType !== 'SEED_DEMO' && !skipJournalRecord) {
    if (!globalForSeed.claimPilotAppliedUploads) {
      globalForSeed.claimPilotAppliedUploads = new Set<string>();
    }
    globalForSeed.claimPilotAppliedUploads.add(logId);
    await recordUploadInCloudJournal({
      id: logId,
      store_pos_code: store.pos_store_code,
      fileType,
      filename,
      content: csvText,
      sourceType,
      createdAt: new Date().toISOString(),
    });
  }

  const totalParsed = parsed.deductionOrders.length + parsed.reversalCredits.length;

  await db.query(
    `INSERT INTO ingestion_logs (
      id, store_id, source_type, file_type, filename,
      records_parsed, records_skipped, claims_reconciled, status,
      sender_email, recipient_email
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'PROCESSED', $8, $9)`,
    [
      logId,
      store.id,
      sourceType,
      fileType,
      filename,
      totalParsed,
      parsed.skippedRows,
      emailMeta?.sender ?? null,
      emailMeta?.recipient ?? store.inbound_email_address,
    ]
  );

  for (const ord of parsed.deductionOrders) {
    await db.query(
      `INSERT INTO delivery_orders (
        id, store_id, ingestion_log_id, platform,
        external_order_id, normalized_order_id, order_suffix_4,
        order_created_at, cancelled_at, driver_arrived_at,
        dd_subtotal_cents, deduction_type, deduction_cents,
        dispute_deadline_at, customer_note, items_summary,
        item_fingerprint, raw_csv_row
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb)
      ON CONFLICT (store_id, platform, external_order_id, deduction_type) DO UPDATE SET
        cancelled_at = COALESCE(EXCLUDED.cancelled_at, delivery_orders.cancelled_at),
        driver_arrived_at = COALESCE(EXCLUDED.driver_arrived_at, delivery_orders.driver_arrived_at),
        dd_subtotal_cents = EXCLUDED.dd_subtotal_cents,
        deduction_cents = EXCLUDED.deduction_cents,
        customer_note = EXCLUDED.customer_note,
        items_summary = EXCLUDED.items_summary,
        item_fingerprint = EXCLUDED.item_fingerprint,
        raw_csv_row = EXCLUDED.raw_csv_row`,
      [
        makeId('ord'),
        store.id,
        logId,
        ord.platform,
        ord.external_order_id,
        ord.normalized_order_id,
        ord.order_suffix_4,
        ord.order_created_at,
        ord.cancelled_at,
        ord.driver_arrived_at,
        ord.dd_subtotal_cents,
        ord.deduction_type,
        ord.deduction_cents,
        ord.dispute_deadline_at,
        ord.customer_note,
        ord.items_summary,
        JSON.stringify(ord.item_fingerprint),
        JSON.stringify(ord.raw_csv_row),
      ]
    );
  }

  const claimsReconciled = await runStoreReconciliation(store.id, store);

  // Reconcile any REVERSAL_CREDIT rows against existing claims for verified payout recovery
  let reversalsApplied = 0;
  for (const credit of parsed.reversalCredits) {
    const matchOrderRes = await db.query<{ id: string }>(
      `SELECT id FROM delivery_orders
       WHERE store_id = $1
         AND normalized_order_id = $2
         AND deduction_type != 'REVERSAL_CREDIT'
       LIMIT 1`,
      [store.id, credit.normalized_order_id]
    );
    if (matchOrderRes.rows.length > 0) {
      const targetOrderId = matchOrderRes.rows[0].id;
      await db.query(
        `UPDATE claims
         SET status = 'WON',
             verified_recovered_cents = $1,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE delivery_order_id = $2`,
        [credit.deduction_cents, targetOrderId]
      );
      reversalsApplied++;
    }
  }

  await db.query(`UPDATE ingestion_logs SET claims_reconciled = $1 WHERE id = $2`, [
    claimsReconciled,
    logId,
  ]);

  return {
    logId,
    recordsParsed: totalParsed,
    recordsSkipped: parsed.skippedRows,
    claimsReconciled,
    reversalsApplied,
  };
}

/**
 * Re-runs the 3-Pass Reconciliation Engine for a store's non-finalized orders while preserving
 * lifecycle states (`SUBMITTED`, `WON`, `LOST`) that an operator has already acted upon.
 */
export async function runStoreReconciliation(
  storeId: string,
  preloadedStore?: StoreConfig
): Promise<number> {
  const db = await getDb();
  const store = preloadedStore ?? (await getStoreById(storeId));
  if (!store) return 0;

  const ordersRes = await db.query<{
    id: string;
    store_id: string;
    ingestion_log_id: string | null;
    platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB';
    external_order_id: string;
    normalized_order_id: string;
    order_suffix_4: string;
    order_created_at: string;
    cancelled_at: string | null;
    driver_arrived_at: string | null;
    dd_subtotal_cents: number;
    deduction_type: DeductionType;
    deduction_cents: number;
    dispute_deadline_at: string;
    customer_note: string | null;
    items_summary: string | null;
    item_fingerprint: string[] | string;
    raw_csv_row: Record<string, string> | string;
  }>(
    `SELECT * FROM delivery_orders
     WHERE store_id = $1 AND deduction_type != 'REVERSAL_CREDIT'
     ORDER BY order_created_at ASC`,
    [storeId]
  );

  const checksRes = await db.query<{
    id: string;
    store_id: string;
    ingestion_log_id: string | null;
    pos_check_number: string;
    raw_external_ref: string | null;
    normalized_external_ref: string | null;
    ref_suffix_4: string | null;
    opened_at: string;
    closed_at: string | null;
    kds_bumped_at: string | null;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    is_voided: boolean;
    item_fingerprint: string[] | string;
    items_json: ParsedLineItem[] | string;
    raw_ej_block: string;
  }>(`SELECT * FROM pos_checks WHERE store_id = $1 ORDER BY opened_at ASC`, [storeId]);

  const deliveryOrders: StoredDeliveryOrder[] = ordersRes.rows.map((o) => ({
    ...o,
    order_created_at: new Date(o.order_created_at).toISOString(),
    cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : null,
    driver_arrived_at: o.driver_arrived_at ? new Date(o.driver_arrived_at).toISOString() : null,
    dispute_deadline_at: new Date(o.dispute_deadline_at).toISOString(),
    item_fingerprint:
      typeof o.item_fingerprint === 'string'
        ? JSON.parse(o.item_fingerprint)
        : o.item_fingerprint,
    raw_csv_row:
      typeof o.raw_csv_row === 'string' ? JSON.parse(o.raw_csv_row) : o.raw_csv_row,
  }));

  const posChecks: StoredPosCheck[] = checksRes.rows.map((c) => ({
    ...c,
    opened_at: new Date(c.opened_at).toISOString(),
    closed_at: c.closed_at ? new Date(c.closed_at).toISOString() : null,
    kds_bumped_at: c.kds_bumped_at ? new Date(c.kds_bumped_at).toISOString() : null,
    item_fingerprint:
      typeof c.item_fingerprint === 'string'
        ? JSON.parse(c.item_fingerprint)
        : c.item_fingerprint,
    items_json: typeof c.items_json === 'string' ? JSON.parse(c.items_json) : c.items_json,
  }));

  // Preserve status, matched_pos_check_id, and verified_recovered_cents of finalized/submitted claims
  const existingClaimsRes = await db.query<{
    id: string;
    delivery_order_id: string;
    matched_pos_check_id: string | null;
    status: ClaimStatus;
    verified_recovered_cents: number;
  }>(
    `SELECT id, delivery_order_id, matched_pos_check_id, status, verified_recovered_cents
     FROM claims WHERE store_id = $1`,
    [storeId]
  );
  const existingByOrder = new Map(
    existingClaimsRes.rows.map((r) => [r.delivery_order_id, r])
  );

  const lockedPosIdsForFinalized = new Set<string>();
  for (const existing of existingClaimsRes.rows) {
    if (
      ['SUBMITTED', 'WON', 'LOST'].includes(existing.status) &&
      existing.matched_pos_check_id
    ) {
      lockedPosIdsForFinalized.add(existing.matched_pos_check_id);
    }
  }

  // Clear matched_pos_check_id locks only on non-finalized claims before re-assigning
  await db.query(
    `UPDATE claims SET matched_pos_check_id = NULL
     WHERE store_id = $1 AND status NOT IN ('SUBMITTED', 'WON', 'LOST')`,
    [storeId]
  );

  const reconciled = reconcileOrdersAndScoreClaims(
    store,
    deliveryOrders,
    posChecks,
    lockedPosIdsForFinalized
  );

  for (const item of reconciled) {
    const existing = existingByOrder.get(item.delivery_order_id);
    const isFinalized =
      existing && ['SUBMITTED', 'WON', 'LOST'].includes(existing.status);
    if (isFinalized) {
      // Do not overwrite finalized/submitted claims
      continue;
    }

    await db.query(
      `INSERT INTO claims (
        id, store_id, delivery_order_id, matched_pos_check_id, adjacent_pos_check_ids,
        match_pass, match_confidence, dispute_score, status, score_breakdown,
        deduction_cents, verified_recovered_cents, rebuttal_text, evidence_packet_json, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb, NOW())
      ON CONFLICT (delivery_order_id) DO UPDATE SET
        matched_pos_check_id = EXCLUDED.matched_pos_check_id,
        adjacent_pos_check_ids = EXCLUDED.adjacent_pos_check_ids,
        match_pass = EXCLUDED.match_pass,
        match_confidence = EXCLUDED.match_confidence,
        dispute_score = EXCLUDED.dispute_score,
        status = $9,
        score_breakdown = EXCLUDED.score_breakdown,
        deduction_cents = EXCLUDED.deduction_cents,
        verified_recovered_cents = $12,
        rebuttal_text = EXCLUDED.rebuttal_text,
        evidence_packet_json = EXCLUDED.evidence_packet_json,
        updated_at = NOW()`,
      [
        existing?.id ?? makeId('clm'),
        storeId,
        item.delivery_order_id,
        item.matched_pos_check_id,
        JSON.stringify(item.adjacent_pos_check_ids),
        item.match_pass,
        item.match_confidence,
        item.dispute_score,
        item.status,
        JSON.stringify(item.score_breakdown),
        item.deduction_cents,
        item.verified_recovered_cents,
        item.rebuttal_text,
        JSON.stringify(item.evidence_packet_json),
      ]
    );
  }

  return reconciled.length;
}

export async function listClaims(storeId?: string): Promise<ClaimRowView[]> {
  await ensureSeeded();
  const db = await getDb();

  const params: unknown[] = [];
  const whereClause = storeId && storeId !== 'ALL' ? `WHERE c.store_id = $1` : '';
  if (storeId && storeId !== 'ALL') {
    params.push(storeId);
  }

  const res = await db.query<Record<string, unknown>>(
    `SELECT
       c.id,
       c.store_id,
       s.name AS store_name,
       s.pos_store_code,
       s.iana_timezone,
       s.menu_markup_pct,
       c.delivery_order_id,
       d.external_order_id,
       d.platform,
       d.order_created_at,
       d.cancelled_at,
       d.driver_arrived_at,
       d.dd_subtotal_cents,
       d.deduction_type,
       c.deduction_cents,
       d.dispute_deadline_at,
       d.customer_note,
       d.items_summary,
       d.raw_csv_row,
       c.matched_pos_check_id,
       p.pos_check_number,
       p.opened_at AS pos_opened_at,
       p.kds_bumped_at AS pos_kds_bumped_at,
       p.subtotal_cents AS pos_subtotal_cents,
       p.raw_ej_block AS pos_raw_ej_block,
       c.match_pass,
       c.match_confidence,
       c.dispute_score,
       c.status,
       c.score_breakdown,
       c.verified_recovered_cents,
       c.rebuttal_text,
       c.evidence_packet_json,
       c.submitted_at,
       c.resolved_at
     FROM claims c
     JOIN stores s ON s.id = c.store_id
     JOIN delivery_orders d ON d.id = c.delivery_order_id
     LEFT JOIN pos_checks p ON p.id = c.matched_pos_check_id
     ${whereClause}
     ORDER BY c.dispute_score DESC, d.dispute_deadline_at ASC`,
    params
  );

  return res.rows.map((r) => ({
    id: String(r.id),
    store_id: String(r.store_id),
    store_name: String(r.store_name),
    pos_store_code: String(r.pos_store_code),
    iana_timezone: String(r.iana_timezone),
    menu_markup_pct: Number(r.menu_markup_pct),
    delivery_order_id: String(r.delivery_order_id),
    external_order_id: String(r.external_order_id),
    platform: String(r.platform),
    order_created_at: new Date(String(r.order_created_at)).toISOString(),
    cancelled_at: r.cancelled_at ? new Date(String(r.cancelled_at)).toISOString() : null,
    driver_arrived_at: r.driver_arrived_at
      ? new Date(String(r.driver_arrived_at)).toISOString()
      : null,
    dd_subtotal_cents: Number(r.dd_subtotal_cents),
    deduction_type: r.deduction_type as DeductionType,
    deduction_cents: Number(r.deduction_cents),
    dispute_deadline_at: new Date(String(r.dispute_deadline_at)).toISOString(),
    customer_note: r.customer_note ? String(r.customer_note) : null,
    items_summary: r.items_summary ? String(r.items_summary) : null,
    raw_csv_row:
      typeof r.raw_csv_row === 'string'
        ? JSON.parse(r.raw_csv_row)
        : (r.raw_csv_row as Record<string, string>),
    matched_pos_check_id: r.matched_pos_check_id ? String(r.matched_pos_check_id) : null,
    pos_check_number: r.pos_check_number ? String(r.pos_check_number) : null,
    pos_opened_at: r.pos_opened_at ? new Date(String(r.pos_opened_at)).toISOString() : null,
    pos_kds_bumped_at: r.pos_kds_bumped_at
      ? new Date(String(r.pos_kds_bumped_at)).toISOString()
      : null,
    pos_subtotal_cents:
      r.pos_subtotal_cents !== null && r.pos_subtotal_cents !== undefined
        ? Number(r.pos_subtotal_cents)
        : null,
    pos_raw_ej_block: r.pos_raw_ej_block ? String(r.pos_raw_ej_block) : null,
    match_pass: r.match_pass as MatchPass,
    match_confidence: Number(r.match_confidence),
    dispute_score: Number(r.dispute_score),
    status: r.status as ClaimStatus,
    score_breakdown:
      typeof r.score_breakdown === 'string'
        ? JSON.parse(r.score_breakdown)
        : (r.score_breakdown as ScoreReason[]),
    verified_recovered_cents: Number(r.verified_recovered_cents),
    rebuttal_text: String(r.rebuttal_text),
    evidence_packet_json:
      typeof r.evidence_packet_json === 'string'
        ? JSON.parse(r.evidence_packet_json)
        : (r.evidence_packet_json as EvidencePacket),
    submitted_at: r.submitted_at ? new Date(String(r.submitted_at)).toISOString() : null,
    resolved_at: r.resolved_at ? new Date(String(r.resolved_at)).toISOString() : null,
  }));
}

export async function updateClaimLifecycleStatus(
  claimId: string,
  newStatus: ClaimStatus
): Promise<void> {
  const db = await getDb();

  if (newStatus === 'SUBMITTED') {
    await db.query(
      `UPDATE claims
       SET status = 'SUBMITTED', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [claimId]
    );
  } else if (newStatus === 'WON') {
    await db.query(
      `UPDATE claims
       SET status = 'WON',
           verified_recovered_cents = deduction_cents,
           resolved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [claimId]
    );
  } else if (newStatus === 'LOST') {
    await db.query(
      `UPDATE claims
       SET status = 'LOST',
           verified_recovered_cents = 0,
           resolved_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [claimId]
    );
  } else {
    await db.query(
      `UPDATE claims
       SET status = $1,
           verified_recovered_cents = 0,
           updated_at = NOW()
       WHERE id = $2`,
      [newStatus, claimId]
    );
  }
}

export async function listIngestionLogs(storeId?: string): Promise<IngestionLogRecord[]> {
  await ensureSeeded();
  const db = await getDb();

  const params: unknown[] = [];
  const whereClause = storeId && storeId !== 'ALL' ? `WHERE l.store_id = $1` : '';
  if (storeId && storeId !== 'ALL') {
    params.push(storeId);
  }

  const res = await db.query<Record<string, unknown>>(
    `SELECT l.*, s.name AS store_name
     FROM ingestion_logs l
     JOIN stores s ON s.id = l.store_id
     ${whereClause}
     ORDER BY l.created_at DESC
     LIMIT 25`,
    params
  );

  return res.rows.map((r) => ({
    id: String(r.id),
    store_id: String(r.store_id),
    store_name: r.store_name ? String(r.store_name) : undefined,
    source_type: r.source_type as IngestionLogRecord['source_type'],
    file_type: r.file_type as IngestionLogRecord['file_type'],
    filename: String(r.filename),
    records_parsed: Number(r.records_parsed),
    records_skipped: Number(r.records_skipped),
    claims_reconciled: Number(r.claims_reconciled),
    status: r.status as 'PROCESSED' | 'FAILED',
    error_summary: r.error_summary ? String(r.error_summary) : null,
    sender_email: r.sender_email ? String(r.sender_email) : null,
    recipient_email: r.recipient_email ? String(r.recipient_email) : null,
    created_at: new Date(String(r.created_at)).toISOString(),
  }));
}
