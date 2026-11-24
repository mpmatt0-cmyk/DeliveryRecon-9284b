import { describe, expect, it } from 'vitest';
import {
  buildItemFingerprintFromSummary,
  computeExpectedPosSubtotalCents,
  computeJaccardSimilarity,
  isSubtotalWithinTolerance,
  localToUtcIso,
  normalizeOrderReference,
  parseCurrencyToCents,
} from '../normalization';
import { parsePosElectronicJournal } from '../parsers/pos-ej-parser';
import { parseDoorDashPayoutCsv } from '../parsers/doordash-csv-parser';
import { reconcileOrdersAndScoreClaims } from '../reconciliation';
import { StoreConfig, StoredDeliveryOrder, StoredPosCheck } from '../types';

const TEST_STORE: StoreConfig = {
  id: 'store_chi_01',
  name: 'Windy City Wings #104 (Lincoln Park)',
  pos_store_code: 'CHI-104',
  dd_merchant_store_id: 'DD-M-992104',
  iana_timezone: 'America/Chicago',
  menu_markup_pct: 0.15, // 15% DoorDash menu markup
  inbound_email_address: 'store-chi-104@ingest.claimpilot.app',
};

describe('Stage 1: Normalization & Timezone Alignment (DST & Currency)', () => {
  it('accurately converts store-local timestamps across Daylight Saving Time (CDT vs CST) into UTC', () => {
    // Before Fall-back DST (CDT is UTC-5) — Oct 25, 2026 18:30:00 in America/Chicago -> 23:30:00Z
    const summerUtc = localToUtcIso('2026-10-25 18:30:00', 'America/Chicago');
    expect(summerUtc).toBe('2026-10-25T23:30:00.000Z');

    // After Fall-back DST (CST is UTC-6) — Nov 15, 2026 18:30:00 in America/Chicago -> Nov 16 00:30:00Z
    const winterUtc = localToUtcIso('2026-11-15 18:30:00', 'America/Chicago');
    expect(winterUtc).toBe('2026-11-16T00:30:00.000Z');
  });

  it('parses currency strings into exact integer cents with zero floating-point drift', () => {
    expect(parseCurrencyToCents('$19.99')).toBe(1999);
    expect(parseCurrencyToCents('-24.50')).toBe(2450);
    expect(parseCurrencyToCents('($1,205.05)')).toBe(120505);
    expect(parseCurrencyToCents('$0.00')).toBe(0);
  });

  it('strips #, DD-, and DOORDASH prefixes to extract normalized order references and 4-char suffixes', () => {
    expect(normalizeOrderReference('DOORDASH #DD-884920A1')).toEqual({
      normalized: '884920A1',
      suffix4: '20A1',
    });
    expect(normalizeOrderReference('#DD-9910-7F4B')).toEqual({
      normalized: '99107F4B',
      suffix4: '7F4B',
    });
    expect(normalizeOrderReference('  #4491  ')).toEqual({
      normalized: '4491',
      suffix4: '4491',
    });
  });

  it('computes markup-adjusted expected POS subtotal and ±2% / ±5 cent tolerances accurately', () => {
    // DoorDash subtotal $23.00 (2300 cents) with 15% markup -> expected POS $20.00 (2000 cents)
    expect(computeExpectedPosSubtotalCents(2300, 0.15)).toBe(2000);

    // 2030 cents is within ±2% (40 cents) of 2000 cents
    const within = isSubtotalWithinTolerance(2030, 2300, 0.15);
    expect(within.matches).toBe(true);

    // 2090 cents exceeds ±2% of 2000 cents
    const outside = isSubtotalWithinTolerance(2090, 2300, 0.15);
    expect(outside.matches).toBe(false);

    // At 0% markup on a small $2.00 check, ±5 cents minimum tolerance applies
    const zeroMarkup = isSubtotalWithinTolerance(204, 200, 0);
    expect(zeroMarkup.matches).toBe(true);
  });
});

describe('Stage 1b: Messy POS Electronic Journal (.txt/.log) Parser', () => {
  const sampleEjLog = `
==========================================
CHK# 4011 | EXT REF: DOORDASH #DD-884920A1
OPENED: 2026-11-18 18:10:00
KDS BUMPED: 2026-11-18 18:21:15
CLOSED: 2026-11-18 18:22:00
1x Wings 10pc                 $14.99
  + Traditional Buffalo
  + Side Ranch
1x Loaded Fries               $5.01
SUBTOTAL:                     $20.00
TAX:                          $2.05
TOTAL:                        $22.05
==========================================
CHK# 4012 | EXT REF: DD-VOIDTEST
OPENED: 2026-11-18 18:12:00
*** VOID CHECK ***
1x Wings 10pc                 $14.99
SUBTOTAL:                     $14.99
TOTAL:                        $14.99
==========================================
CHK# 4013
OPENED: 2026-11-18 18:14:00
1x Water Cup                  $0.00
SUBTOTAL:                     $0.00
TOTAL:                        $0.00
==========================================
`;

  it('extracts valid checks, ignores voided checks and $0.00 checks, and preserves verbatim raw_ej_block', () => {
    const parsed = parsePosElectronicJournal(sampleEjLog, 'America/Chicago');

    expect(parsed.totalBlocksInspect).toBe(3);
    expect(parsed.validChecks.length).toBe(1);
    expect(parsed.skippedVoidOrZeroChecks.length).toBe(2);

    const check = parsed.validChecks[0];
    expect(check.pos_check_number).toBe('4011');
    expect(check.normalized_external_ref).toBe('884920A1');
    expect(check.ref_suffix_4).toBe('20A1');
    expect(check.subtotal_cents).toBe(2000);
    expect(check.kds_bumped_at).toBe('2026-11-19T00:21:15.000Z');
    expect(check.raw_ej_block).toContain('CHK# 4011');
    expect(check.raw_ej_block).toContain('+ Side Ranch');
  });
});

describe('Stage 2 & 3: 3-Pass Reconciliation Engine, 1-to-1 Claim Lock & Anti-Ban Confidence Gate', () => {
  it('executes Pass 1 (Exact Ref), Pass 2 (Adjusted Subtotal + Window), Pass 3 (Jaccard Tie-Break), and enforces 1-to-1 Claim Lock', () => {
    const posChecks: StoredPosCheck[] = [
      // Check A: Matches Order 1 via Pass 1 Exact Suffix (20A1)
      {
        id: 'chk_pass1',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        pos_check_number: '5001',
        raw_external_ref: 'DD-20A1',
        normalized_external_ref: '20A1',
        ref_suffix_4: '20A1',
        opened_at: '2026-11-20T00:12:00.000Z',
        closed_at: '2026-11-20T00:24:00.000Z',
        kds_bumped_at: '2026-11-20T00:22:00.000Z',
        subtotal_cents: 2400,
        tax_cents: 240,
        total_cents: 2640,
        is_voided: false,
        item_fingerprint: buildItemFingerprintFromSummary('1x Wings 10pc, 1x Ranch, 1x Fries'),
        items_json: [
          {
            quantity: 1,
            raw_name: 'Wings 10pc',
            normalized_token: '1x_10pc_wings',
            price_cents: 1800,
            modifiers: ['Ranch'],
          },
          {
            quantity: 1,
            raw_name: 'Fries',
            normalized_token: '1x_fries',
            price_cents: 600,
            modifiers: [],
          },
        ],
        raw_ej_block: 'CHK# 5001 | EXT REF: DD-20A1\n1x Wings 10pc $18.00\n1x Fries $6.00',
      },
      // Check B: No external ref, matches Order 2 via Pass 2 Markup-Adjusted Subtotal ($20.00 POS vs $23.00 DD @ 15% markup)
      {
        id: 'chk_pass2',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        pos_check_number: '5002',
        raw_external_ref: null,
        normalized_external_ref: null,
        ref_suffix_4: null,
        opened_at: '2026-11-20T01:05:00.000Z', // +5 mins after DD order creation
        closed_at: '2026-11-20T01:18:00.000Z',
        kds_bumped_at: '2026-11-20T01:14:00.000Z', // Ready BEFORE driver arrival at 01:19:00Z
        subtotal_cents: 2000,
        tax_cents: 200,
        total_cents: 2200,
        is_voided: false,
        item_fingerprint: buildItemFingerprintFromSummary('2x Classic Burger'),
        items_json: [
          {
            quantity: 2,
            raw_name: 'Classic Burger',
            normalized_token: '2x_burger',
            price_cents: 2000,
            modifiers: [],
          },
        ],
        raw_ej_block: 'CHK# 5002\n2x Classic Burger $20.00\nKDS BUMPED: 19:14:00',
      },
      // Check C1 & Check C2: Rush-hour subtotal collision! Both have $30.00 POS subtotal at 02:04:00Z,
      // but C1 has Pizza+Soda while C2 has Wings+Ranch+Tenders. Pass 3 Jaccard must pick C2!
      {
        id: 'chk_pass3_wrong_items',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        pos_check_number: '5003',
        raw_external_ref: null,
        normalized_external_ref: null,
        ref_suffix_4: null,
        opened_at: '2026-11-20T02:03:00.000Z',
        closed_at: '2026-11-20T02:16:00.000Z',
        kds_bumped_at: '2026-11-20T02:15:00.000Z',
        subtotal_cents: 3000,
        tax_cents: 300,
        total_cents: 3300,
        is_voided: false,
        item_fingerprint: buildItemFingerprintFromSummary('2x Pepperoni Pizza, 2x Cola'),
        items_json: [
          {
            quantity: 2,
            raw_name: 'Pepperoni Pizza',
            normalized_token: '2x_pep_pizza',
            price_cents: 3000,
            modifiers: [],
          },
        ],
        raw_ej_block: 'CHK# 5003\n2x Pepperoni Pizza $30.00',
      },
      {
        id: 'chk_pass3_right_items',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        pos_check_number: '5004',
        raw_external_ref: null,
        normalized_external_ref: null,
        ref_suffix_4: null,
        opened_at: '2026-11-20T02:04:00.000Z',
        closed_at: '2026-11-20T02:17:00.000Z',
        kds_bumped_at: '2026-11-20T02:16:00.000Z',
        subtotal_cents: 3000,
        tax_cents: 300,
        total_cents: 3300,
        is_voided: false,
        item_fingerprint: buildItemFingerprintFromSummary(
          '1x Wings 10pc, 1x Ranch, 1x Chicken Tenders'
        ),
        items_json: [
          {
            quantity: 1,
            raw_name: 'Wings 10pc',
            normalized_token: '1x_10pc_wings',
            price_cents: 1800,
            modifiers: ['Ranch'],
          },
          {
            quantity: 1,
            raw_name: 'Chicken Tenders',
            normalized_token: '1x_chicken_tenders',
            price_cents: 1200,
            modifiers: [],
          },
        ],
        raw_ej_block: 'CHK# 5004\n1x Wings 10pc $18.00\n  + Ranch\n1x Chicken Tenders $12.00',
      },
    ];

    const deliveryOrders: StoredDeliveryOrder[] = [
      // Order 1: CANCELLED_AFTER_PREP -> Matches Check 5001 via Pass 1 -> Score 98 AUTO_QUEUE
      {
        id: 'ord_1',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        platform: 'DOORDASH',
        external_order_id: 'DD-884920A1',
        normalized_order_id: '884920A1',
        order_suffix_4: '20A1',
        order_created_at: '2026-11-20T00:10:00.000Z',
        cancelled_at: '2026-11-20T00:25:00.000Z', // Cancelled 3 mins AFTER KDS bump (00:22:00Z)
        driver_arrived_at: null,
        dd_subtotal_cents: 2760,
        deduction_type: 'CANCELLED_AFTER_PREP',
        deduction_cents: 2760,
        dispute_deadline_at: '2026-12-04T00:10:00.000Z',
        customer_note: 'Order cancelled by customer after prep',
        items_summary: '1x Wings 10pc, 1x Ranch, 1x Fries',
        item_fingerprint: buildItemFingerprintFromSummary('1x Wings 10pc, 1x Ranch, 1x Fries'),
        raw_csv_row: {},
      },
      // Order 2: PREP_TIME_PENALTY -> Matches Check 5002 via Pass 2 -> Score 92 AUTO_QUEUE
      {
        id: 'ord_2',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        platform: 'DOORDASH',
        external_order_id: 'DD-771099B2',
        normalized_order_id: '771099B2',
        order_suffix_4: '99B2',
        order_created_at: '2026-11-20T01:00:00.000Z',
        cancelled_at: null,
        driver_arrived_at: '2026-11-20T01:19:00.000Z', // Driver arrived 5 mins AFTER KDS bump (01:14:00Z)
        dd_subtotal_cents: 2300, // 2300 / 1.15 = 2000 cents expected POS
        deduction_type: 'PREP_TIME_PENALTY',
        deduction_cents: 1000,
        dispute_deadline_at: '2026-12-04T01:00:00.000Z',
        customer_note: 'Avoidable Dasher wait penalty',
        items_summary: '2x Classic Burger',
        item_fingerprint: buildItemFingerprintFromSummary('2x Classic Burger'),
        raw_csv_row: {},
      },
      // Order 3: MISSING_ITEM >= $15.00 -> Rush-hour subtotal collision ($34.50 DD / 1.15 = $30.00 POS)
      // Must disambiguate via Pass 3 Jaccard Similarity to pick Check 5004 -> Score 80 AUTO_QUEUE
      {
        id: 'ord_3',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        platform: 'DOORDASH',
        external_order_id: 'DD-662011C3',
        normalized_order_id: '662011C3',
        order_suffix_4: '11C3',
        order_created_at: '2026-11-20T02:00:00.000Z',
        cancelled_at: null,
        driver_arrived_at: null,
        dd_subtotal_cents: 3450,
        deduction_type: 'MISSING_ITEM',
        deduction_cents: 1850, // $18.50 >= $15.00 threshold
        dispute_deadline_at: '2026-12-04T02:00:00.000Z',
        customer_note: 'Missing 10pc wings and ranch',
        items_summary: '1x Wings 10pc, 1x Ranch, 1x Chicken Tenders',
        item_fingerprint: buildItemFingerprintFromSummary(
          '1x Wings 10pc, 1x Ranch, 1x Chicken Tenders'
        ),
        raw_csv_row: {},
      },
      // Order 4: FALSE_STORE_CLOSED within ±10 mins of Check 5004 (02:04:00Z) -> Score 95 AUTO_QUEUE
      {
        id: 'ord_4',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        platform: 'DOORDASH',
        external_order_id: 'DD-CLOSED-99',
        normalized_order_id: 'CLOSED99',
        order_suffix_4: 'ED99',
        order_created_at: '2026-11-20T02:08:00.000Z',
        cancelled_at: null,
        driver_arrived_at: null,
        dd_subtotal_cents: 0,
        deduction_type: 'FALSE_STORE_CLOSED',
        deduction_cents: 2500,
        dispute_deadline_at: '2026-12-04T02:08:00.000Z',
        customer_note: 'Store reported closed by Dasher',
        items_summary: '',
        item_fingerprint: [],
        raw_csv_row: {},
      },
      // Order 5: Low-dollar deduction ($3.50 < $5.00) -> Score < 70 IGNORED (Anti-Ban Protection)
      {
        id: 'ord_5',
        store_id: TEST_STORE.id,
        ingestion_log_id: null,
        platform: 'DOORDASH',
        external_order_id: 'DD-LOW-001',
        normalized_order_id: 'LOW001',
        order_suffix_4: 'W001',
        order_created_at: '2026-11-20T03:00:00.000Z',
        cancelled_at: null,
        driver_arrived_at: null,
        dd_subtotal_cents: 1500,
        deduction_type: 'MISSING_ITEM',
        deduction_cents: 350,
        dispute_deadline_at: '2026-12-04T03:00:00.000Z',
        customer_note: 'Missing side sauce',
        items_summary: '1x Ranch',
        item_fingerprint: ['1x_ranch'],
        raw_csv_row: {},
      },
    ];

    const claims = reconcileOrdersAndScoreClaims(TEST_STORE, deliveryOrders, posChecks);
    expect(claims.length).toBe(5);

    const claim1 = claims.find((c) => c.delivery_order_id === 'ord_1')!;
    expect(claim1.match_pass).toBe('PASS_1_EXACT_REF');
    expect(claim1.matched_pos_check_id).toBe('chk_pass1');
    expect(claim1.dispute_score).toBe(98);
    expect(claim1.status).toBe('AUTO_QUEUE');

    const claim2 = claims.find((c) => c.delivery_order_id === 'ord_2')!;
    expect(claim2.match_pass).toBe('PASS_2_SUBTOTAL_WINDOW');
    expect(claim2.matched_pos_check_id).toBe('chk_pass2');
    expect(claim2.dispute_score).toBe(92);
    expect(claim2.status).toBe('AUTO_QUEUE');

    const claim3 = claims.find((c) => c.delivery_order_id === 'ord_3')!;
    expect(claim3.match_pass).toBe('PASS_3_ITEM_JACCARD');
    expect(claim3.matched_pos_check_id).toBe('chk_pass3_right_items');
    expect(claim3.dispute_score).toBe(80);
    expect(claim3.status).toBe('AUTO_QUEUE');

    const claim4 = claims.find((c) => c.delivery_order_id === 'ord_4')!;
    expect(claim4.match_pass).toBe('STORE_ACTIVITY_PROOF');
    expect(claim4.dispute_score).toBe(95);
    expect(claim4.status).toBe('AUTO_QUEUE');
    expect(claim4.adjacent_pos_check_ids.length).toBeGreaterThanOrEqual(2);

    const claim5 = claims.find((c) => c.delivery_order_id === 'ord_5')!;
    expect(claim5.dispute_score).toBeLessThan(70);
    expect(claim5.status).toBe('IGNORED');
  });

  it('parses DoorDash payout CSV rows including chargebacks and reversal credits', () => {
    const csv = `order_id,order_created_at,cancelled_at,driver_arrived_at,subtotal,error_charge,transaction_type,items,customer_note
DD-884920A1,2026-11-18 18:08:00,2026-11-18 18:24:00,,$23.00,-$23.00,Cancelled After Prep,"1x Wings 10pc, 1x Side Ranch, 1x Loaded Fries",Customer cancelled after food cooked
DD-884920A1,2026-11-22 10:00:00,,,$23.00,+$23.00,Dispute Credit Reversal,"1x Wings 10pc",Dispute approved credit`;

    const res = parseDoorDashPayoutCsv(csv, 'America/Chicago');
    expect(res.deductionOrders.length).toBe(1);
    expect(res.reversalCredits.length).toBe(1);
    expect(res.deductionOrders[0].deduction_type).toBe('CANCELLED_AFTER_PREP');
    expect(res.deductionOrders[0].deduction_cents).toBe(2300);
    expect(res.reversalCredits[0].deduction_type).toBe('REVERSAL_CREDIT');
  });
});
