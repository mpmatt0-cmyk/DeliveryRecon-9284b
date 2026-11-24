import { ParsedLineItem } from './types';

/**
 * Converts a local timestamp string (e.g., "2026-11-01 01:30:00" or "11/15/2026 18:42:10")
 * in a store's explicit IANA timezone (e.g., "America/Chicago", "America/New_York")
 * into a canonical UTC ISO-8601 string (TIMESTAMPTZ).
 *
 * Handles Daylight Saving Time (DST) transitions deterministically using Intl.DateTimeFormat parts.
 */
export function localToUtcIso(localDateTimeStr: string, ianaTimezone: string): string {
  const trimmed = localDateTimeStr.trim();

  // If the string already carries an explicit UTC or ISO offset ('Z' or '+/-HH:MM' at end), parse directly
  if (/Z$/i.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid ISO timestamp: "${localDateTimeStr}"`);
    }
    return parsed.toISOString();
  }

  const components = parseLocalComponents(trimmed);
  const { year, month, day, hour, minute, second } = components;

  // Initial UTC guess assuming 0 offset
  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, second);

  // Iterative offset refinement across DST boundaries (2 passes resolve spring-forward / fall-back)
  const offsetPass1 = getTimezoneOffsetMs(utcGuessMs, ianaTimezone);
  const refinedUtcMs1 = utcGuessMs - offsetPass1;
  const offsetPass2 = getTimezoneOffsetMs(refinedUtcMs1, ianaTimezone);
  const finalUtcMs = utcGuessMs - offsetPass2;

  return new Date(finalUtcMs).toISOString();
}

/**
 * Formats a UTC ISO-8601 timestamp into the store's human-readable local time with timezone abbreviation.
 */
export function formatUtcInStoreTimezone(utcIso: string | null, ianaTimezone: string): string {
  if (!utcIso) return 'N/A';
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) return utcIso;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return formatter.format(date);
}

function getTimezoneOffsetMs(utcTimestampMs: number, ianaTimezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = dtf.formatToParts(new Date(utcTimestampMs));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = parseInt(part.value, 10);
    }
  }

  const zonedAsUtcMs = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour === 24 ? 0 : map.hour,
    map.minute,
    map.second
  );

  return zonedAsUtcMs - utcTimestampMs;
}

function parseLocalComponents(raw: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  // Format 1: YYYY-MM-DD HH:mm[:ss] or YYYY-MM-DDTHH:mm[:ss]
  const isoLike = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*(AM|PM))?$/i
  );
  if (isoLike) {
    let hour = parseInt(isoLike[4], 10);
    const ampm = isoLike[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return {
      year: parseInt(isoLike[1], 10),
      month: parseInt(isoLike[2], 10),
      day: parseInt(isoLike[3], 10),
      hour,
      minute: parseInt(isoLike[5], 10),
      second: isoLike[6] ? parseInt(isoLike[6], 10) : 0,
    };
  }

  // Format 2: MM/DD/YYYY HH:mm[:ss] [AM|PM]
  const usLike = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i
  );
  if (usLike) {
    let year = parseInt(usLike[3], 10);
    if (year < 100) year += 2000;
    let hour = parseInt(usLike[4], 10);
    const ampm = usLike[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return {
      year,
      month: parseInt(usLike[1], 10),
      day: parseInt(usLike[2], 10),
      hour,
      minute: parseInt(usLike[5], 10),
      second: usLike[6] ? parseInt(usLike[6], 10) : 0,
    };
  }

  throw new Error(`Unsupported timestamp format: "${raw}"`);
}

/**
 * Converts a dollar string or number (e.g., "$24.95", "-18.50", "(15.00)", 12.34)
 * into non-negative integer cents. Uses string-first decimal arithmetic to avoid
 * floating-point inaccuracies.
 */
export function parseCurrencyToCents(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return 0;
    return Math.round(Math.abs(input) * 100);
  }

  const cleaned = input.trim();
  if (!cleaned) return 0;

  // Strip $, commas, parentheses, signs, and spaces
  const numericStr = cleaned.replace(/[$,()\s+-]/g, '');
  if (!numericStr || !/^\d+(\.\d+)?$/.test(numericStr)) {
    return 0;
  }

  const [wholePart, fracPart = ''] = numericStr.split('.');
  const wholeCents = parseInt(wholePart, 10) * 100;
  const paddedFrac = (fracPart + '00').slice(0, 2);
  const thirdDigit = fracPart.length >= 3 ? parseInt(fracPart[2], 10) : 0;
  const fracCents = parseInt(paddedFrac, 10) + (thirdDigit >= 5 ? 1 : 0);

  return wholeCents + fracCents;
}

/**
 * Formats integer cents as standard USD currency string (e.g., 1545 -> "$15.45").
 */
export function formatCentsToUsd(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Strips delivery platform prefixes (#, DD-, DOORDASH, UBER, GH, spaces, punctuation)
 * from an order reference string and returns both the uppercase alphanumeric code
 * and its 4-character suffix.
 */
export function normalizeOrderReference(rawRef: string | null | undefined): {
  normalized: string | null;
  suffix4: string | null;
} {
  if (!rawRef) return { normalized: null, suffix4: null };

  let cleaned = rawRef.trim().toUpperCase();
  // Strip leading # and common prefix patterns repeatedly (e.g., "DOORDASH #DD-884920A1", "#DD-9910-7F4B")
  cleaned = cleaned
    .replace(/^[#\s:-]+/, '')
    .replace(/^(DOORDASH|DOOR\s*DASH|DD|UBEREATS|UBER|UE|GRUBHUB|GH|ORDER|REF|EXT|ID|CHK|CHECK)[\s#:-]*/gi, '')
    .replace(/^[#\s:-]+/, '')
    .replace(/^(DOORDASH|DOOR\s*DASH|DD|UBEREATS|UBER|UE|GRUBHUB|GH|ORDER|REF|ID)[\s#:-]*/gi, '')
    .replace(/[^A-Z0-9]/g, '');

  if (!cleaned) {
    return { normalized: null, suffix4: null };
  }

  const suffix4 = cleaned.length >= 4 ? cleaned.slice(-4) : cleaned;
  return {
    normalized: cleaned,
    suffix4,
  };
}

/**
 * Calculates the expected POS subtotal in cents from a DoorDash subtotal in cents
 * and the store's configured menu markup percentage:
 * expected_pos = round(dd_subtotal / (1 + markup_pct))
 */
export function computeExpectedPosSubtotalCents(
  ddSubtotalCents: number,
  menuMarkupPct: number
): number {
  if (ddSubtotalCents <= 0) return 0;
  const divisor = 1 + Math.max(0, menuMarkupPct);
  return Math.round(ddSubtotalCents / divisor);
}

/**
 * Checks whether a POS check's subtotal matches the expected markup-adjusted subtotal
 * within ±2% (or ±5 cents when menu_markup_pct is 0 or tolerance is smaller than 5 cents).
 */
export function isSubtotalWithinTolerance(
  posSubtotalCents: number,
  ddSubtotalCents: number,
  menuMarkupPct: number
): { matches: boolean; expectedPosCents: number; diffCents: number; toleranceCents: number } {
  const expectedPosCents = computeExpectedPosSubtotalCents(ddSubtotalCents, menuMarkupPct);
  const diffCents = Math.abs(posSubtotalCents - expectedPosCents);
  const toleranceCents =
    menuMarkupPct === 0
      ? Math.max(5, Math.round(expectedPosCents * 0.02))
      : Math.max(5, Math.round(expectedPosCents * 0.02));

  return {
    matches: diffCents <= toleranceCents,
    expectedPosCents,
    diffCents,
    toleranceCents,
  };
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'with',
  'combo',
  'meal',
  'order',
  'special',
  'regular',
  'reg',
  'large',
  'lg',
  'small',
  'sm',
  'side',
  'of',
  'fresh',
  'hot',
  'crispy',
  'classic',
  'house',
]);

const SYNONYM_MAP: Record<string, string> = {
  wings: 'wings',
  wing: 'wings',
  boneless: 'boneless',
  bnls: 'boneless',
  pc: 'pc',
  pcs: 'pc',
  piece: 'pc',
  pieces: 'pc',
  fries: 'fries',
  fry: 'fries',
  ff: 'fries',
  ranch: 'ranch',
  rnch: 'ranch',
  blue: 'bleu',
  bleu: 'bleu',
  cheese: 'chs',
  chs: 'chs',
  chz: 'chs',
  burger: 'burger',
  brgr: 'burger',
  pizza: 'pizza',
  pza: 'pizza',
  pepperoni: 'pep',
  pep: 'pep',
  drink: 'drink',
  soda: 'drink',
  cola: 'cola',
  coke: 'cola',
  tenders: 'tenders',
  tender: 'tenders',
  tndr: 'tenders',
  sauce: 'sauce',
  sc: 'sauce',
};

/**
 * Normalizes a single item quantity + name into a canonical token like "1x_wings_10pc"
 */
export function normalizeItemToken(quantity: number, rawName: string): string {
  const qty = Math.max(1, Math.round(quantity || 1));

  // Normalize "10 pc" / "10-piece" -> "10pc" before splitting words
  const preCleaned = rawName
    .toLowerCase()
    .replace(/(\d+)\s*[-\s]?\s*(pc|pcs|piece|pieces|oz|ct)\b/g, '$1pc')
    .replace(/[^a-z0-9\s]/g, ' ');

  const words = preCleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SYNONYM_MAP[w] ?? w)
    .filter((w) => !STOP_WORDS.has(w));

  const sortedCore = Array.from(new Set(words)).sort();
  if (sortedCore.length === 0) {
    return `${qty}x_item`;
  }
  return `${qty}x_${sortedCore.join('_')}`;
}

/**
 * Builds an array of canonical item tokens from a list of parsed line items or a summary string.
 */
export function buildItemFingerprintFromItems(items: ParsedLineItem[]): string[] {
  const tokens: string[] = [];
  for (const item of items) {
    tokens.push(item.normalized_token);
    for (const mod of item.modifiers) {
      const modToken = normalizeItemToken(1, mod);
      if (modToken !== '1x_item') {
        tokens.push(modToken);
      }
    }
  }
  return Array.from(new Set(tokens)).sort();
}

/**
 * Parses a DoorDash CSV summary string (e.g., "1x Wings 10pc, 1x Ranch, 2x Fries")
 * into a canonical item fingerprint array (e.g., ["1x_ranch", "1x_10pc_wings", "2x_fries"]).
 */
export function buildItemFingerprintFromSummary(summary: string | null | undefined): string[] {
  if (!summary || !summary.trim()) return [];

  const segments = summary
    .split(/[,;|+\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const seg of segments) {
    const match = seg.match(/^(\d+)\s*[xX*×]?\s+(.+)$/);
    if (match) {
      const qty = parseInt(match[1], 10);
      const name = match[2];
      tokens.push(normalizeItemToken(qty, name));
    } else {
      tokens.push(normalizeItemToken(1, seg));
    }
  }

  return Array.from(new Set(tokens)).sort();
}

/**
 * Computes Jaccard Similarity between two item fingerprint arrays (0.0 to 1.0).
 * Also checks token-stem overlap so minor POS abbreviation differences still correlate accurately.
 */
export function computeJaccardSimilarity(fpA: string[], fpB: string[]): number {
  if (fpA.length === 0 || fpB.length === 0) return 0;

  const setA = new Set(fpA);
  const setB = new Set(fpB);

  let intersectionCount = 0;
  const matchedB = new Set<string>();

  for (const tokenA of setA) {
    if (setB.has(tokenA)) {
      intersectionCount += 1;
      matchedB.add(tokenA);
      continue;
    }

    // Soft token match if same quantity prefix and >= 60% sub-word overlap
    const [qtyA, ...wordsA] = tokenA.split('_');
    for (const tokenB of setB) {
      if (matchedB.has(tokenB)) continue;
      const [qtyB, ...wordsB] = tokenB.split('_');
      if (qtyA === qtyB && wordsA.length > 0 && wordsB.length > 0) {
        const subOverlap = wordsA.filter((w) => wordsB.includes(w)).length;
        const subUnion = new Set([...wordsA, ...wordsB]).size;
        if (subOverlap / subUnion >= 0.5) {
          intersectionCount += 1;
          matchedB.add(tokenB);
          break;
        }
      }
    }
  }

  const unionSize = setA.size + setB.size - intersectionCount;
  if (unionSize <= 0) return 0;
  return Number((intersectionCount / unionSize).toFixed(4));
}
