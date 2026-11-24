import {
  buildItemFingerprintFromSummary,
  localToUtcIso,
  normalizeOrderReference,
  parseCurrencyToCents,
} from '../normalization';
import { ParsedDeliveryOrder } from '../types';
import {
  classifyDeliveryDeductionType,
  findCsvField,
  parseCsvRows,
} from './csv-utils';

export interface GrubhubCsvParseResult {
  deductionOrders: ParsedDeliveryOrder[];
  reversalCredits: ParsedDeliveryOrder[];
  skippedRows: number;
}

const GRUBHUB_DISPUTE_WINDOW_DAYS = 30;

/**
 * Grubhub Financial Payout & Adjustment CSV Parser (Phase 2)
 *
 * Parses Grubhub for Restaurants settlement/adjustment CSV reports.
 * - Enforces 30-day dispute deadline (`order_created_at + 30 days`).
 * - Converts local timestamps to UTC via store `ianaTimezone` and currency to integer cents.
 */
export function parseGrubhubPayoutCsv(
  csvText: string,
  ianaTimezone: string
): GrubhubCsvParseResult {
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

    const rawOrderId =
      findCsvField(rawRow, [
        'order_number',
        'grubhub_order_id',
        'order_id',
        'external_order_id',
      ]) ?? '';

    const { normalized: normalizedOrderId, suffix4: orderSuffix4 } =
      normalizeOrderReference(rawOrderId);
    if (!normalizedOrderId || !orderSuffix4) {
      skippedRows++;
      continue;
    }

    const rawCreated =
      findCsvField(rawRow, [
        'transaction_date',
        'order_date',
        'order_created_at',
        'created_at',
      ]) ?? '';
    if (!rawCreated) {
      skippedRows++;
      continue;
    }

    const orderCreatedAt = localToUtcIso(rawCreated, ianaTimezone);
    const rawCancelled = findCsvField(rawRow, ['cancelled_at', 'canceled_at']);
    const cancelledAt = rawCancelled ? localToUtcIso(rawCancelled, ianaTimezone) : null;

    const rawDriverArrived = findCsvField(rawRow, [
      'driver_arrived_at',
      'courier_arrived_at',
    ]);
    const driverArrivedAt = rawDriverArrived
      ? localToUtcIso(rawDriverArrived, ianaTimezone)
      : null;

    const ddSubtotalCents = parseCurrencyToCents(
      findCsvField(rawRow, ['subtotal', 'food_subtotal', 'order_subtotal'])
    );

    const rawDeduction =
      findCsvField(rawRow, [
        'adjustment_amount',
        'merchant_adjustment',
        'deduction_amount',
        'error_charge',
      ]) ?? '0';
    const deductionCents = parseCurrencyToCents(rawDeduction);
    if (deductionCents <= 0) {
      skippedRows++;
      continue;
    }

    const rawCategory =
      findCsvField(rawRow, [
        'adjustment_reason',
        'transaction_type',
        'reason',
        'error_category',
      ]) ?? '';
    const customerNote =
      findCsvField(rawRow, ['diner_note', 'customer_note', 'notes', 'reason_detail']) ?? null;
    const itemsSummary =
      findCsvField(rawRow, ['items', 'item_list', 'items_summary']) ?? null;

    const deductionType = classifyDeliveryDeductionType(
      rawCategory,
      customerNote,
      rawDeduction
    );

    const disputeDeadlineAt = new Date(
      new Date(orderCreatedAt).getTime() + GRUBHUB_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const parsed: ParsedDeliveryOrder = {
      platform: 'GRUBHUB',
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
      raw_csv_row: rawRow,
    };

    if (deductionType === 'REVERSAL_CREDIT') {
      reversalCredits.push(parsed);
    } else {
      deductionOrders.push(parsed);
    }
  }

  return { deductionOrders, reversalCredits, skippedRows };
}
