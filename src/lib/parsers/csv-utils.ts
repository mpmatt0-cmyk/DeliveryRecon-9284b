import { DeductionType } from '../types';

/**
 * Shared RFC-4180 CSV row tokenizer supporting quoted commas and escaped quotes.
 */
export function parseCsvRows(csvText: string): string[][] {
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

export function findCsvField(
  row: Record<string, string>,
  candidates: string[]
): string | undefined {
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

export function classifyDeliveryDeductionType(
  rawCategory: string,
  customerNote: string | null,
  rawAmountStr: string,
  explicitPositiveIsCredit = true
): DeductionType {
  const combined = `${rawCategory} ${customerNote ?? ''}`.toLowerCase();

  if (
    /reversal|dispute\s*credit|error\s*charge\s*refund|reimbursement|won\s*dispute|payout\s*credit|adjustment\s*credit|merchant\s*credit/i.test(
      combined
    ) ||
    (explicitPositiveIsCredit && rawAmountStr.trim().startsWith('+'))
  ) {
    return 'REVERSAL_CREDIT';
  }

  if (/cancel.*prep|cancelled|canceled|order\s*cancel|unfulfilled\s*after/i.test(combined)) {
    return 'CANCELLED_AFTER_PREP';
  }

  if (
    /prep\s*time|driver\s*wait|dasher\s*wait|courier\s*wait|wait\s*time|late\s*prep|avoidable\s*wait/i.test(
      combined
    )
  ) {
    return 'PREP_TIME_PENALTY';
  }

  if (/store\s*closed|closed\s*early|restaurant\s*closed|hours\s*error/i.test(combined)) {
    return 'FALSE_STORE_CLOSED';
  }

  if (
    /cold|soggy|taste|spicy|burnt|greasy|too\s*salty|quality|didn't\s*like|inedible/i.test(
      combined
    ) &&
    !/missing|forgot|omitted/i.test(combined)
  ) {
    return 'QUALITY_SUBJECTIVE';
  }

  if (
    /missing|incorrect\s*item|inaccurate|omitted|forgot|wrong\s*modifier|never\s*received\s*item|missing\s*item/i.test(
      combined
    )
  ) {
    return 'MISSING_ITEM';
  }

  return 'OTHER';
}
