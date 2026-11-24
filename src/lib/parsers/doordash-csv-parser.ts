import {
  buildItemFingerprintFromSummary,
  localToUtcIso,
  normalizeOrderReference,
  parseCurrencyToCents,
} from '../normalization';
import { DeductionType, ParsedDeliveryOrder } from '../types';

export interface DoorDashCsvParseResult {
  deductionOrders: ParsedDeliveryOrder[];
  reversalCredits: ParsedDeliveryOrder[];
  skippedRows: number;
}

const DOORDASH_DISPUTE_WINDOW_DAYS = 14;

/**
 * DoorDash Financial Payout CSV Parser
 *
 * Parses standard DoorDash Merchant Portal financial / error charge CSV reports.
 * - Converts local timestamps to UTC using store's `ianaTimezone` (or direct ISO if UTC).
 * - Converts subtotals and chargeback deductions into integer cents (`INT`).
 * - Classifies rows into canonical `DeductionType`:
 *   - `CANCELLED_AFTER_PREP`
 *   - `PREP_TIME_PENALTY`
 *   - `FALSE_STORE_CLOSED`
 *   - `MISSING_ITEM`
 *   - `QUALITY_SUBJECTIVE`
 *   - `REVERSAL_CREDIT` (for subsequent payout credit verification)
 * - Computes `dispute_deadline_at = order_created_at + 14 days`.
 * - Preserves verbatim `raw_csv_row` JSON for retroactive auditing.
 */
export function parseDoorDashPayoutCsv(
  csvText: string,
  ianaTimezone: string
): DoorDashCsvParseResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { deductionOrders: [], reversalCredits: [], skippedRows: 0 };
  }

  const headers = rows[0].map((h) => h.trim());
  const deductionOrders: ParsedDeliveryOrder[] = [];
  const reversalCredits: ParsedDeliveryOrder[] = [];
  let skippedRows = 0;

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    if (values.length === 0 || values.every((v) => !v.trim())) {
      continue;
    }

    const rawRow: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rawRow[h] = (values[idx] ?? '').trim();
    });

    const parsed = mapCsvRowToDeliveryOrder(rawRow, ianaTimezone);
    if (!parsed) {
      skippedRows++;
      continue;
    }

    if (parsed.deduction_type === 'REVERSAL_CREDIT') {
      reversalCredits.push(parsed);
    } else {
      deductionOrders.push(parsed);
    }
  }

  return {
    deductionOrders,
    reversalCredits,
    skippedRows,
  };
}

function mapCsvRowToDeliveryOrder(
  row: Record<string, string>,
  ianaTimezone: string
): ParsedDeliveryOrder | null {
  const rawOrderId =
    findField(row, [
      'order_id',
      'doordash_order_id',
      'external_order_id',
      'order id',
      'delivery_uuid',
      'reference_id',
    ]) ?? '';

  const { normalized: normalizedOrderId, suffix4: orderSuffix4 } =
    normalizeOrderReference(rawOrderId);

  if (!normalizedOrderId || !orderSuffix4) {
    return null;
  }

  const rawCreated =
    findField(row, [
      'order_created_at',
      'created_at',
      'timestamp_local',
      'order_timestamp',
      'date_time',
      'order date',
    ]) ?? '';

  if (!rawCreated) {
    return null;
  }

  const orderCreatedAt = localToUtcIso(rawCreated, ianaTimezone);

  const rawCancelled = findField(row, [
    'cancelled_at',
    'cancellation_timestamp',
    'cancelled_time',
  ]);
  const cancelledAt = rawCancelled ? localToUtcIso(rawCancelled, ianaTimezone) : null;

  const rawDriverArrived = findField(row, [
    'driver_arrived_at',
    'dasher_arrived_at',
    'arrival_timestamp',
    'dasher_at_store_time',
  ]);
  const driverArrivedAt = rawDriverArrived
    ? localToUtcIso(rawDriverArrived, ianaTimezone)
    : null;

  const rawSubtotal = findField(row, [
    'subtotal',
    'order_subtotal',
    'dd_subtotal',
    'gross_sales',
  ]);
  const ddSubtotalCents = parseCurrencyToCents(rawSubtotal);

  const rawDeduction =
    findField(row, [
      'error_charge',
      'deduction_amount',
      'chargeback_amount',
      'deduction',
      'fee_deduction',
      'credit_amount',
      'adjustment_amount',
    ]) ?? '0';
  const deductionCents = parseCurrencyToCents(rawDeduction);

  if (deductionCents <= 0) {
    return null;
  }

  const rawCategory =
    findField(row, [
      'transaction_type',
      'error_category',
      'deduction_type',
      'reason',
      'charge_reason',
      'issue_type',
    ]) ?? '';

  const customerNote =
    findField(row, [
      'customer_note',
      'customer_comment',
      'issue_description',
      'notes',
      'details',
    ]) ?? null;

  const itemsSummary =
    findField(row, ['items', 'items_summary', 'item_list', 'disputed_items']) ?? null;

  const deductionType = classifyDeductionType(rawCategory, customerNote, rawDeduction);

  const createdMs = new Date(orderCreatedAt).getTime();
  const disputeDeadlineAt = new Date(
    createdMs + DOORDASH_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  return {
    platform: 'DOORDASH',
    external_order_id: rawOrderId.trim(),
    normalized_order_id: normalizedOrderId,
    order_suffix_4: orderSuffix4,
    order_created_at: orderCreatedAt,
    cancelled_at: cancelledAt,
    driver_arrived_at: driverArrivedAt,
    dd_subtotal_cents: ddSubtotalCents,
    deduction_type: deductionType,
    deduction_cents: deductionCents,
    dispute_deadline_at: disputeDeadlineAt,
    customer_note: customerNote,
    items_summary: itemsSummary,
    item_fingerprint: buildItemFingerprintFromSummary(itemsSummary),
    raw_csv_row: row,
  };
}

function classifyDeductionType(
  rawCategory: string,
  customerNote: string | null,
  rawAmountStr: string
): DeductionType {
  const combined = `${rawCategory} ${customerNote ?? ''}`.toLowerCase();

  if (
    /reversal|dispute\s*credit|error\s*charge\s*refund|reimbursement|won\s*dispute|payout\s*credit/i.test(
      combined
    ) ||
    rawAmountStr.trim().startsWith('+')
  ) {
    return 'REVERSAL_CREDIT';
  }

  if (/cancel.*prep|cancelled|canceled|order\s*cancel/i.test(combined)) {
    return 'CANCELLED_AFTER_PREP';
  }

  if (
    /prep\s*time|driver\s*wait|dasher\s*wait|wait\s*time|late\s*prep|avoidable\s*wait/i.test(
      combined
    )
  ) {
    return 'PREP_TIME_PENALTY';
  }

  if (/store\s*closed|closed\s*early|unfulfilled.*closed|hours\s*error/i.test(combined)) {
    return 'FALSE_STORE_CLOSED';
  }

  if (
    /cold|soggy|taste|spicy|burnt|greasy|too\s*salty|quality|didn't\s*like/i.test(combined) &&
    !/missing|forgot|omitted/i.test(combined)
  ) {
    return 'QUALITY_SUBJECTIVE';
  }

  if (
    /missing|incorrect\s*item|omitted|forgot|wrong\s*modifier|never\s*received\s*item/i.test(
      combined
    )
  ) {
    return 'MISSING_ITEM';
  }

  return 'OTHER';
}

function findField(row: Record<string, string>, candidates: string[]): string | undefined {
  const lowerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    lowerMap[k.toLowerCase().replace(/[\s_-]+/g, '_')] = v;
  }

  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/[\s_-]+/g, '_');
    if (lowerMap[key] !== undefined && lowerMap[key] !== '') {
      return lowerMap[key];
    }
  }
  return undefined;
}

/**
 * RFC-4180 compliant CSV row tokenizer supporting quoted commas and escaped quotes.
 */
function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  const text = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (ch === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}
