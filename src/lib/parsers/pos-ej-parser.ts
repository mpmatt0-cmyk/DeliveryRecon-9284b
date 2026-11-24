import {
  buildItemFingerprintFromItems,
  localToUtcIso,
  normalizeItemToken,
  normalizeOrderReference,
  parseCurrencyToCents,
} from '../normalization';
import { ParsedLineItem, ParsedPosCheck } from '../types';

export interface PosEjParseResult {
  validChecks: ParsedPosCheck[];
  skippedVoidOrZeroChecks: ParsedPosCheck[];
  totalBlocksInspect: number;
}

/**
 * Universal POS Electronic Journal (EJ) Parser (.txt / .log)
 *
 * Supports multi-vendor check blocks (Toast, Aloha, PAR Brink, Micros, Square text exports).
 * Extracts:
 * - Check Number (`CHK#`, `CHECK #`, `Check:`, `Order #`)
 * - External Delivery Reference (`EXT REF:`, `DOORDASH #`, `DD-`, `Delivery Ref:`)
 * - Opened / Closed / KDS Bump timestamps converted from `ianaTimezone` to UTC ISO-8601
 * - Line items, quantities, prices, and indented modifiers (`+`, `>`, `MOD:`, `*`)
 * - Subtotal, Tax, Total in integer cents
 * - Void markers (`*** VOID ***`, `STATUS: VOIDED`, `[VOID CHECK]`)
 * - Verbatim `raw_ej_block` preservation for audit & dispute packet inclusion
 *
 * Enforces Business Rules:
 * - Filters out voided checks (`is_voided = true`) and `$0.00` test transactions (`subtotal_cents === 0`)
 *   into `skippedVoidOrZeroChecks` so only valid checks enter active reconciliation.
 */
export function parsePosElectronicJournal(
  rawText: string,
  ianaTimezone: string
): PosEjParseResult {
  const normalizedText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawBlocks = splitIntoCheckBlocks(normalizedText);

  const validChecks: ParsedPosCheck[] = [];
  const skippedVoidOrZeroChecks: ParsedPosCheck[] = [];

  for (const block of rawBlocks) {
    const parsed = parseSingleCheckBlock(block, ianaTimezone);
    if (!parsed) continue;

    if (parsed.is_voided || parsed.subtotal_cents <= 0) {
      skippedVoidOrZeroChecks.push(parsed);
    } else {
      validChecks.push(parsed);
    }
  }

  return {
    validChecks,
    skippedVoidOrZeroChecks,
    totalBlocksInspect: rawBlocks.length,
  };
}

function splitIntoCheckBlocks(text: string): string[] {
  // Split on explicit separator lines (===, ---) or before new CHECK/CHK header lines
  const lines = text.split('\n');
  const blocks: string[] = [];
  let currentLines: string[] = [];

  const isSeparator = (line: string) => /^[=_-]{10,}$/.test(line.trim());
  const isCheckHeader = (line: string) =>
    /^(?:CHK|CHECK|ORDER|TICKET)\s*(?:NO\.?|#|NUMBER|:)\s*[A-Z0-9-]+/i.test(line.trim());

  for (const line of lines) {
    if (isSeparator(line)) {
      if (currentLines.some((l) => l.trim().length > 0)) {
        blocks.push(currentLines.join('\n').trim());
        currentLines = [];
      }
      continue;
    }

    if (
      isCheckHeader(line) &&
      currentLines.some((l) => isCheckHeader(l)) &&
      currentLines.join('\n').trim().length > 0
    ) {
      blocks.push(currentLines.join('\n').trim());
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.some((l) => l.trim().length > 0)) {
    blocks.push(currentLines.join('\n').trim());
  }

  return blocks.filter((b) => b.length > 0);
}

function parseSingleCheckBlock(block: string, ianaTimezone: string): ParsedPosCheck | null {
  const lines = block.split('\n');

  let posCheckNumber: string | null = null;
  let rawExternalRef: string | null = null;
  let openedLocalStr: string | null = null;
  let closedLocalStr: string | null = null;
  let kdsBumpedLocalStr: string | null = null;
  let subtotalCents: number | null = null;
  let taxCents = 0;
  let totalCents = 0;
  let isVoided = false;

  const items: ParsedLineItem[] = [];
  let currentItem: ParsedLineItem | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 1. Detect VOID status
    if (
      /\*\*\*\s*VOID(?:ED)?\s*\*\*\*/i.test(line) ||
      /\b(?:CHECK|ORDER|STATUS)\s*[:=-]?\s*VOID(?:ED)?\b/i.test(line) ||
      /^\[VOID(?:ED)?\]$/i.test(line) ||
      /\bVOID\s+CHECK\b/i.test(line)
    ) {
      isVoided = true;
    }

    // 2. Detect Check Number
    if (!posCheckNumber) {
      const chkMatch = line.match(
        /(?:CHK|CHECK|TICKET)\s*(?:NO\.?|#|NUMBER|:)?\s*([A-Z0-9-]{2,})/i
      );
      if (chkMatch) {
        posCheckNumber = chkMatch[1].trim();
      }
    }

    // 3. Detect External Delivery Reference (DoorDash / Ext Ref)
    if (!rawExternalRef) {
      const extMatch =
        line.match(
          /(?:EXT(?:ERNAL)?\s*REF(?:ERENCE)?|DELIVERY\s*(?:REF|ID|ORDER)|THIRD\s*PARTY\s*ID|PARTNER\s*REF)\s*[:#=-]?\s*([#A-Z0-9-\s]+)/i
        ) ||
        line.match(/\b((?:DOORDASH|DD)\s*[#:-]?\s*[A-Z0-9-]{4,})\b/i);

      if (extMatch) {
        // Stop before trailing pipe or timestamp metadata on the same line
        const candidate = extMatch[1].split(/[|]/)[0].trim();
        if (candidate) {
          rawExternalRef = candidate;
        }
      }
    }

    // 4. Detect Opened Timestamp
    const openedMatch = line.match(
      /(?:OPEN(?:ED)?|CREATED|START(?:ED)?|DATE|TIME)\s*[:=-]?\s*(\d{4}-\d{1,2}-\d{1,2}[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i
    );
    if (openedMatch && !openedLocalStr) {
      openedLocalStr = openedMatch[1].trim();
    }

    // 5. Detect KDS Bump / Kitchen Ready Timestamp
    const kdsMatch = line.match(
      /(?:KDS\s*(?:BUMP(?:ED)?|READY|DONE|COMPLETE)|KITCHEN\s*(?:BUMP(?:ED)?|READY)|EXPO\s*BUMP(?:ED)?)\s*(?:AT)?\s*[:=-]?\s*(\d{4}-\d{1,2}-\d{1,2}[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i
    );
    if (kdsMatch && !kdsBumpedLocalStr) {
      kdsBumpedLocalStr = kdsMatch[1].trim();
    }

    // 6. Detect Closed / Paid Timestamp
    const closedMatch = line.match(
      /(?:CLOSE(?:D)?|PAID|SETTLED|TENDERED)\s*(?:AT)?\s*[:=-]?\s*(\d{4}-\d{1,2}-\d{1,2}[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i
    );
    if (closedMatch && !closedLocalStr) {
      closedLocalStr = closedMatch[1].trim();
    }

    // 7. Detect Subtotal / Tax / Total
    const subMatch = line.match(/^(?:SUB\s*TOTAL|SUBTOTAL|NET\s*SALES)\s*[:.]*\s*([$()0-9.,+-]+)$/i);
    if (subMatch) {
      subtotalCents = parseCurrencyToCents(subMatch[1]);
      continue;
    }

    const taxMatch = line.match(/^(?:TAX|SALES\s*TAX)\s*[:.]*\s*([$()0-9.,+-]+)$/i);
    if (taxMatch) {
      taxCents = parseCurrencyToCents(taxMatch[1]);
      continue;
    }

    const totMatch = line.match(/^(?:TOTAL|AMOUNT\s*DUE|GRAND\s*TOTAL|CHECK\s*TOTAL)\s*[:.]*\s*([$()0-9.,+-]+)$/i);
    if (totMatch) {
      totalCents = parseCurrencyToCents(totMatch[1]);
      continue;
    }

    // 8. Detect Modifiers (e.g., "+ Extra Ranch", "> Mod: Mild Sauce", "* Side Bleu Cheese")
    const modMatch = rawLine.match(/^\s*(?:[+>*]|MOD(?:IFIER)?\s*:)\s*(.+?)(?:\s+\$?\d+\.\d{2})?$/i);
    if (modMatch && currentItem) {
      const modText = modMatch[1].trim();
      if (modText && !/VOID/i.test(modText)) {
        currentItem.modifiers.push(modText);
      }
      continue;
    }

    // 9. Detect Line Items (e.g., "1x Wings 10pc       $14.99" or "2  Classic Burger   21.00")
    const itemMatch = line.match(
      /^(\d+)\s*[xX*×]?\s+([A-Za-z0-9][A-Za-z0-9\s/&'().-]{1,42}?)\s+\$?(\d+\.\d{2})$/
    );
    if (itemMatch) {
      const qty = parseInt(itemMatch[1], 10);
      const rawName = itemMatch[2].trim();
      const priceCents = parseCurrencyToCents(itemMatch[3]);
      currentItem = {
        quantity: qty,
        raw_name: rawName,
        normalized_token: normalizeItemToken(qty, rawName),
        price_cents: priceCents,
        modifiers: [],
      };
      items.push(currentItem);
    }
  }

  if (!posCheckNumber || !openedLocalStr) {
    return null;
  }

  const openedAtUtc = localToUtcIso(openedLocalStr, ianaTimezone);
  const openedMs = new Date(openedAtUtc).getTime();
  const datePrefix = extractDatePart(openedLocalStr);

  const kdsBumpedAtUtc = kdsBumpedLocalStr
    ? resolveRolloverUtc(kdsBumpedLocalStr, datePrefix, openedMs, ianaTimezone)
    : null;

  const closedAtUtc = closedLocalStr
    ? resolveRolloverUtc(closedLocalStr, datePrefix, openedMs, ianaTimezone)
    : null;

  const computedItemsSubtotal = items.reduce((acc, it) => acc + it.price_cents, 0);
  const finalSubtotalCents =
    subtotalCents !== null ? subtotalCents : computedItemsSubtotal;

  const finalTotalCents =
    totalCents > 0 ? totalCents : finalSubtotalCents + taxCents;

  const { normalized: normalizedExternalRef, suffix4: refSuffix4 } =
    normalizeOrderReference(rawExternalRef);

  const itemFingerprint = buildItemFingerprintFromItems(items);

  return {
    pos_check_number: posCheckNumber,
    raw_external_ref: rawExternalRef,
    normalized_external_ref: normalizedExternalRef,
    ref_suffix_4: refSuffix4,
    opened_at: openedAtUtc,
    closed_at: closedAtUtc,
    kds_bumped_at: kdsBumpedAtUtc,
    subtotal_cents: isVoided ? 0 : finalSubtotalCents,
    tax_cents: isVoided ? 0 : taxCents,
    total_cents: isVoided ? 0 : finalTotalCents,
    is_voided: isVoided,
    item_fingerprint: itemFingerprint,
    items_json: items,
    raw_ej_block: block,
  };
}

function extractDatePart(dateTimeStr: string): string {
  const isoMatch = dateTimeStr.match(/^(\d{4}-\d{1,2}-\d{1,2})/);
  if (isoMatch) return isoMatch[1];
  const usMatch = dateTimeStr.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (usMatch) return usMatch[1];
  return '';
}

function resolveRolloverUtc(
  timeOrDateTime: string,
  fallbackDatePart: string,
  openedAtMs: number,
  ianaTimezone: string
): string {
  const hasExplicitDate = !/^\d{1,2}:\d{2}/.test(timeOrDateTime.trim());
  const candidateIso = localToUtcIso(
    ensureDatePart(timeOrDateTime, fallbackDatePart),
    ianaTimezone
  );
  if (!hasExplicitDate && new Date(candidateIso).getTime() < openedAtMs) {
    // Time-only timestamp crossed midnight after check opened; advance by 24 hours
    return new Date(new Date(candidateIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  return candidateIso;
}

function ensureDatePart(timeOrDateTime: string, fallbackDatePart: string): string {
  if (/^\d{1,2}:\d{2}/.test(timeOrDateTime.trim()) && fallbackDatePart) {
    return `${fallbackDatePart} ${timeOrDateTime.trim()}`;
  }
  return timeOrDateTime;
}
