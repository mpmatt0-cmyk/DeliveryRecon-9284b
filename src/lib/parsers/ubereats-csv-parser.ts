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

export interface UberEatsCsvParseResult {
  deductionOrders: ParsedDeliveryOrder[];
  reversalCredits: ParsedDeliveryOrder[];
  skippedRows: number;
}

const UBEREATS_DISPUTE_WINDOW_DAYS = 30;

/**
 * UberEats Financial Payout & Order Error CSV Parser (Phase 2)
 *
 * Parses UberEats Manager Payment / Order Accuracy CSV exports.
 * - Enforces UberEats ~30-day rolling dispute deadline (`order_created_at + 30 days`).
 * - Converts local timestamps to UTC via store `ianaTimezone` and currency to integer cents.
 */
export function parseUberEatsPayoutCsv(
  csvText: string,
  ianaTimezone: string
): UberEatsCsvParseResult {
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
        'order_id',
        'workflow_id',
        'ubereats_order_id',
        'order_uuid',
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
        'order_date',
        'order_created_at',
        'created_at',
        'order_timestamp',
        'date',
      ]) ?? '';
    if (!rawCreated) {
      skippedRows++;
      continue;
    }

    const orderCreatedAt = localToUtcIso(rawCreated, ianaTimezone);
    const rawCancelled = findCsvField(rawRow, ['cancelled_at', 'canceled_at', 'cancel_time']);
    const cancelledAt = rawCancelled ? localToUtcIso(rawCancelled, ianaTimezone) : null;

    const rawCourierArrived = findCsvField(rawRow, [
      'courier_arrived_at',
      'driver_arrived_at',
      'pickup_arrival_time',
    ]);
    const driverArrivedAt = rawCourierArrived
      ? localToUtcIso(rawCourierArrived, ianaTimezone)
      : null;

    const ddSubtotalCents = parseCurrencyToCents(
      findCsvField(rawRow, ['food_sales', 'subtotal', 'order_subtotal', 'sales_excl_tax'])
    );

    const rawDeduction =
      findCsvField(rawRow, [
        'inaccurate_order_adjustment',
        'order_error_adjustment',
        'adjustment_amount',
        'deduction_amount',
        'error_charge',
        'dispute_credit',
      ]) ?? '0';
    const deductionCents = parseCurrencyToCents(rawDeduction);
    if (deductionCents <= 0) {
      skippedRows++;
      continue;
    }

    const rawCategory =
      findCsvField(rawRow, [
        'issue_type',
        'adjustment_reason',
        'error_category',
        'order_status',
        'reason',
      ]) ?? '';
    const customerNote =
      findCsvField(rawRow, ['customer_note', 'eater_comment', 'issue_details', 'notes']) ??
      null;
    const itemsSummary =
      findCsvField(rawRow, ['items', 'disputed_items', 'item_names', 'items_summary']) ?? null;

    const deductionType = classifyDeliveryDeductionType(
      rawCategory,
      customerNote,
      rawDeduction
    );

    const disputeDeadlineAt = new Date(
      new Date(orderCreatedAt).getTime() + UBEREATS_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const parsed: ParsedDeliveryOrder = {
      platform: 'UBEREATS',
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
