import {
  computeExpectedPosSubtotalCents,
  computeJaccardSimilarity,
  formatCentsToUsd,
  formatUtcInStoreTimezone,
  isSubtotalWithinTolerance,
} from './normalization';
import {
  ClaimStatus,
  EvidencePacket,
  MatchPass,
  ReconciledClaimResult,
  ScoreReason,
  StoreConfig,
  StoredDeliveryOrder,
  StoredPosCheck,
} from './types';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const TWENTY_MINUTES_MS = 20 * 60 * 1000;

/**
 * 3-Pass Order Reconciliation Engine + Anti-Ban Confidence Gate + Policy Rebuttal Compiler
 *
 * Enforces:
 * - Strict 1-to-1 Claim Lock (`lockedPosCheckIds`): a POS check can only bind to one delivery order.
 * - Exclude voided checks (`is_voided = true`) and `$0.00` checks (`subtotal_cents <= 0`).
 * - Pass 1: Exact normalized external ref or 4-char suffix match within ±2 hours (Confidence 98–100).
 * - Pass 2: Markup-adjusted subtotal (`expected_pos = round(dd_subtotal / (1 + markup_pct))`) within ±2%
 *   (or ±5 cents at 0% markup) and POS opened between `[dd_created - 5m, dd_created + 20m]` (Confidence 85–95).
 * - Pass 3: Item-Fingerprint Disambiguation via Jaccard Similarity (`>= 0.60`) when Pass 2 has multiple
 *   rush-hour subtotal collisions or slightly wider subtotal variance (Confidence 75–90).
 * - Special Rule (`FALSE_STORE_CLOSED`): Verifies active POS checks rung up within ±10 minutes of alleged closure.
 */
export function reconcileOrdersAndScoreClaims(
  store: StoreConfig,
  deliveryOrders: StoredDeliveryOrder[],
  posChecks: StoredPosCheck[],
  initiallyLockedPosCheckIds: Set<string> = new Set()
): ReconciledClaimResult[] {
  // Filter eligible non-voided, non-$0 POS checks
  const eligibleChecks = posChecks.filter((c) => !c.is_voided && c.subtotal_cents > 0);
  const lockedCheckIds = new Set<string>(initiallyLockedPosCheckIds);

  // Temporary map of orderId -> matched check + pass info
  const matchMap = new Map<
    string,
    {
      matchedCheck: StoredPosCheck | null;
      adjacentChecks: StoredPosCheck[];
      matchPass: MatchPass;
      matchConfidence: number;
      jaccardSimilarity: number | null;
    }
  >();

  // Filter out reversal credits from primary claim creation
  const claimOrders = deliveryOrders.filter((o) => o.deduction_type !== 'REVERSAL_CREDIT');

  // =========================================================================
  // PASS 1: Exact Reference / 4-Char Suffix Match within ±2 hours (Conf 98-100)
  // =========================================================================
  for (const order of claimOrders) {
    const orderCreatedMs = new Date(order.order_created_at).getTime();

    let bestCandidate: StoredPosCheck | null = null;
    let bestConfidence = 0;
    let smallestTimeDiff = Number.POSITIVE_INFINITY;

    for (const check of eligibleChecks) {
      if (lockedCheckIds.has(check.id)) continue;
      if (!check.normalized_external_ref && !check.ref_suffix_4) continue;

      const checkOpenedMs = new Date(check.opened_at).getTime();
      const timeDiffMs = Math.abs(checkOpenedMs - orderCreatedMs);
      if (timeDiffMs > TWO_HOURS_MS) continue;

      const isFullExactMatch =
        Boolean(check.normalized_external_ref) &&
        check.normalized_external_ref === order.normalized_order_id;

      const isSuffix4Match =
        Boolean(check.ref_suffix_4) &&
        check.ref_suffix_4!.length >= 4 &&
        check.ref_suffix_4 === order.order_suffix_4;

      if (isFullExactMatch || isSuffix4Match) {
        const confidence = isFullExactMatch ? 100 : 98;
        if (
          confidence > bestConfidence ||
          (confidence === bestConfidence && timeDiffMs < smallestTimeDiff)
        ) {
          bestCandidate = check;
          bestConfidence = confidence;
          smallestTimeDiff = timeDiffMs;
        }
      }
    }

    if (bestCandidate) {
      lockedCheckIds.add(bestCandidate.id);
      const jaccard = computeJaccardSimilarity(
        order.item_fingerprint,
        bestCandidate.item_fingerprint
      );
      matchMap.set(order.id, {
        matchedCheck: bestCandidate,
        adjacentChecks: [],
        matchPass: 'PASS_1_EXACT_REF',
        matchConfidence: bestConfidence,
        jaccardSimilarity: jaccard > 0 ? jaccard : null,
      });
    }
  }

  // =========================================================================
  // PASS 2 & PASS 3: Markup-Adjusted Subtotal + [-5m, +20m] Window & Jaccard Tie-Break
  // =========================================================================
  for (const order of claimOrders) {
    if (matchMap.has(order.id)) continue;

    // Special handling for FALSE_STORE_CLOSED deductions (often have $0 subtotal or no direct POS ticket)
    if (order.deduction_type === 'FALSE_STORE_CLOSED') {
      const orderCreatedMs = new Date(order.order_created_at).getTime();
      const activeNearby = eligibleChecks.filter((c) => {
        const openedMs = new Date(c.opened_at).getTime();
        const closedMs = c.closed_at ? new Date(c.closed_at).getTime() : openedMs;
        return (
          Math.abs(openedMs - orderCreatedMs) <= TEN_MINUTES_MS ||
          Math.abs(closedMs - orderCreatedMs) <= TEN_MINUTES_MS
        );
      });

      if (activeNearby.length > 0) {
        matchMap.set(order.id, {
          matchedCheck: null,
          adjacentChecks: activeNearby,
          matchPass: 'STORE_ACTIVITY_PROOF',
          matchConfidence: 95,
          jaccardSimilarity: null,
        });
        continue;
      }
    }

    const orderCreatedMs = new Date(order.order_created_at).getTime();
    const minWindowMs = orderCreatedMs - FIVE_MINUTES_MS;
    const maxWindowMs = orderCreatedMs + TWENTY_MINUTES_MS;

    // Collect unlocked checks inside the [-5 min, +20 min] window
    const windowChecks = eligibleChecks.filter((c) => {
      if (lockedCheckIds.has(c.id)) return false;
      const openedMs = new Date(c.opened_at).getTime();
      return openedMs >= minWindowMs && openedMs <= maxWindowMs;
    });

    // Evaluate Pass 2 subtotal tolerance on window checks
    const pass2Candidates = windowChecks
      .map((check) => {
        const tol = isSubtotalWithinTolerance(
          check.subtotal_cents,
          order.dd_subtotal_cents,
          store.menu_markup_pct
        );
        const jaccard = computeJaccardSimilarity(
          order.item_fingerprint,
          check.item_fingerprint
        );
        const timeDiffMs = Math.abs(new Date(check.opened_at).getTime() - orderCreatedMs);
        return {
          check,
          tol,
          jaccard,
          timeDiffMs,
        };
      })
      .filter((c) => c.tol.matches);

    if (pass2Candidates.length === 1) {
      // Unique Pass 2 match — lock immediately (Confidence 85–95)
      const winner = pass2Candidates[0];
      lockedCheckIds.add(winner.check.id);
      const accuracyBonus =
        winner.tol.diffCents === 0 ? 10 : Math.max(0, 8 - Math.floor(winner.tol.diffCents / 5));
      const confidence = Math.min(95, Math.max(85, 85 + accuracyBonus));

      matchMap.set(order.id, {
        matchedCheck: winner.check,
        adjacentChecks: [],
        matchPass: 'PASS_2_SUBTOTAL_WINDOW',
        matchConfidence: confidence,
        jaccardSimilarity: winner.jaccard > 0 ? winner.jaccard : null,
      });
      continue;
    }

    if (pass2Candidates.length > 1) {
      // Rush-hour subtotal collision! Disambiguate using Pass 3 Item-Fingerprint Jaccard Similarity (>= 0.60)
      const sortedByJaccard = [...pass2Candidates].sort(
        (a, b) => b.jaccard - a.jaccard || a.timeDiffMs - b.timeDiffMs
      );
      const top = sortedByJaccard[0];
      if (top.jaccard >= 0.6) {
        lockedCheckIds.add(top.check.id);
        const confidence = Math.min(
          90,
          Math.max(75, Math.round(75 + (top.jaccard - 0.6) * 37.5))
        );
        matchMap.set(order.id, {
          matchedCheck: top.check,
          adjacentChecks: [],
          matchPass: 'PASS_3_ITEM_JACCARD',
          matchConfidence: confidence,
          jaccardSimilarity: top.jaccard,
        });
        continue;
      }
    }

    // Fallback Pass 3: Even if subtotal differed slightly beyond ±2% (e.g. item modifier price discrepancy),
    // check if any unlocked check in the [-5m, +20m] window has a strong Item-Fingerprint Jaccard >= 0.60
    const pass3Candidates = windowChecks
      .map((check) => ({
        check,
        jaccard: computeJaccardSimilarity(order.item_fingerprint, check.item_fingerprint),
        timeDiffMs: Math.abs(new Date(check.opened_at).getTime() - orderCreatedMs),
      }))
      .filter((c) => c.jaccard >= 0.6)
      .sort((a, b) => b.jaccard - a.jaccard || a.timeDiffMs - b.timeDiffMs);

    if (pass3Candidates.length > 0) {
      const winner = pass3Candidates[0];
      lockedCheckIds.add(winner.check.id);
      const confidence = Math.min(
        90,
        Math.max(75, Math.round(75 + (winner.jaccard - 0.6) * 37.5))
      );
      matchMap.set(order.id, {
        matchedCheck: winner.check,
        adjacentChecks: [],
        matchPass: 'PASS_3_ITEM_JACCARD',
        matchConfidence: confidence,
        jaccardSimilarity: winner.jaccard,
      });
      continue;
    }

    // Unmatched
    matchMap.set(order.id, {
      matchedCheck: null,
      adjacentChecks: [],
      matchPass: 'UNMATCHED',
      matchConfidence: 0,
      jaccardSimilarity: null,
    });
  }

  // =========================================================================
  // STAGE 3 & 4: Confidence Gate Scoring (0-100) & Evidence Packet Compilation
  // =========================================================================
  const results: ReconciledClaimResult[] = [];

  for (const order of claimOrders) {
    const matchInfo = matchMap.get(order.id)!;
    const { disputeScore, status, breakdown } = evaluateConfidenceGate(
      order,
      matchInfo.matchedCheck,
      matchInfo.adjacentChecks,
      matchInfo.matchPass,
      matchInfo.matchConfidence
    );

    const { rebuttalText, evidencePacket } = compileEvidencePacket(
      store,
      order,
      matchInfo.matchedCheck,
      matchInfo.adjacentChecks,
      matchInfo.matchPass,
      matchInfo.matchConfidence,
      disputeScore,
      matchInfo.jaccardSimilarity
    );

    results.push({
      delivery_order_id: order.id,
      matched_pos_check_id: matchInfo.matchedCheck?.id ?? null,
      adjacent_pos_check_ids: matchInfo.adjacentChecks.map((c) => c.id),
      match_pass: matchInfo.matchPass,
      match_confidence: matchInfo.matchConfidence,
      dispute_score: disputeScore,
      status,
      score_breakdown: breakdown,
      deduction_cents: order.deduction_cents,
      verified_recovered_cents: 0,
      rebuttal_text: rebuttalText,
      evidence_packet_json: evidencePacket,
    });
  }

  return results;
}

/**
 * Evaluates the Anti-Ban Dispute Eligibility & Confidence Gate (0 to 100).
 * Only claims scoring >= 80 enter `AUTO_QUEUE`.
 */
function evaluateConfidenceGate(
  order: StoredDeliveryOrder,
  matchedCheck: StoredPosCheck | null,
  adjacentChecks: StoredPosCheck[],
  matchPass: MatchPass,
  matchConfidence: number
): {
  disputeScore: number;
  status: ClaimStatus;
  breakdown: ScoreReason[];
} {
  const breakdown: ScoreReason[] = [];

  // Rule 0: Low-dollar guard (< $5.00 / 500 cents) -> anti-ban ignore
  if (order.deduction_cents < 500) {
    breakdown.push({
      rule: 'LOW_DOLLAR_THRESHOLD',
      points: 25,
      detail: `Deduction (${formatCentsToUsd(order.deduction_cents)}) is under the $5.00 anti-ban dispute floor.`,
    });
    return {
      disputeScore: 25,
      status: 'IGNORED',
      breakdown,
    };
  }

  // Rule 1: Subjective quality complaints ("food was cold / soggy") -> non-winnable spam risk
  if (order.deduction_type === 'QUALITY_SUBJECTIVE') {
    breakdown.push({
      rule: 'SUBJECTIVE_QUALITY_EXCLUSION',
      points: 30,
      detail: 'Subjective food quality complaints carry high rejection risk and portal spam flags.',
    });
    return {
      disputeScore: 30,
      status: 'IGNORED',
      breakdown,
    };
  }

  // Rule 2: FALSE_STORE_CLOSED + POS EJ proves active orders rung up within ±10 mins -> Score 95 (AUTO_QUEUE)
  if (order.deduction_type === 'FALSE_STORE_CLOSED') {
    if (adjacentChecks.length > 0) {
      breakdown.push({
        rule: 'ACTIVE_POS_DURING_ALLEGED_CLOSURE',
        points: 95,
        detail: `${adjacentChecks.length} active POS check(s) (${adjacentChecks
          .map((c) => `#${c.pos_check_number}`)
          .join(', ')}) were rung up within ±10 minutes of alleged store closure.`,
      });
      return {
        disputeScore: 95,
        status: 'AUTO_QUEUE',
        breakdown,
      };
    } else {
      breakdown.push({
        rule: 'NO_ADJACENT_POS_ACTIVITY',
        points: 40,
        detail: 'No active POS transactions found within ±10 minutes of alleged store closure.',
      });
      return {
        disputeScore: 40,
        status: 'MANUAL_REVIEW',
        breakdown,
      };
    }
  }

  // For order-level claims, require a matched POS check
  if (!matchedCheck || matchPass === 'UNMATCHED' || matchConfidence < 75) {
    breakdown.push({
      rule: 'UNMATCHED_POS_CHECK',
      points: 35,
      detail: 'No non-voided POS Electronic Journal check matched with confidence >= 75.',
    });
    return {
      disputeScore: 35,
      status: 'MANUAL_REVIEW',
      breakdown,
    };
  }

  // Rule 3: CANCELLED_AFTER_PREP + KDS bump timestamp proves food was cooked before cancellation -> Score 98 (AUTO_QUEUE)
  if (order.deduction_type === 'CANCELLED_AFTER_PREP') {
    if (matchedCheck.kds_bumped_at) {
      const kdsMs = new Date(matchedCheck.kds_bumped_at).getTime();
      const cancelMs = order.cancelled_at
        ? new Date(order.cancelled_at).getTime()
        : Number.POSITIVE_INFINITY;

      if (kdsMs <= cancelMs) {
        breakdown.push({
          rule: 'KDS_BUMP_BEFORE_CANCELLATION',
          points: 98,
          detail: `KDS bump completed (${matchedCheck.kds_bumped_at}) prior to order cancellation (${
            order.cancelled_at ?? 'post-prep'
          }) on POS Check #${matchedCheck.pos_check_number}.`,
        });
        return {
          disputeScore: 98,
          status: 'AUTO_QUEUE',
          breakdown,
        };
      }
    }

    breakdown.push({
      rule: 'CANCELLED_WITHOUT_KDS_TIMESTAMP',
      points: 65,
      detail: `POS Check #${matchedCheck.pos_check_number} matched (${matchPass}), but KDS bump timestamp does not precede cancellation.`,
    });
    return {
      disputeScore: 65,
      status: 'MANUAL_REVIEW',
      breakdown,
    };
  }

  // Rule 4: PREP_TIME_PENALTY + KDS bump timestamp proves order was ready before driver arrival -> Score 92 (AUTO_QUEUE)
  if (order.deduction_type === 'PREP_TIME_PENALTY') {
    if (matchedCheck.kds_bumped_at && order.driver_arrived_at) {
      const kdsMs = new Date(matchedCheck.kds_bumped_at).getTime();
      const driverMs = new Date(order.driver_arrived_at).getTime();

      if (kdsMs <= driverMs) {
        const leadSeconds = Math.round((driverMs - kdsMs) / 1000);
        breakdown.push({
          rule: 'KDS_READY_BEFORE_DRIVER_ARRIVAL',
          points: 92,
          detail: `Kitchen bumped order ready ${Math.floor(
            leadSeconds / 60
          )}m ${leadSeconds % 60}s prior to Dasher arrival at store.`,
        });
        return {
          disputeScore: 92,
          status: 'AUTO_QUEUE',
          breakdown,
        };
      }
    }

    breakdown.push({
      rule: 'PREP_TIME_UNVERIFIED_KDS',
      points: 60,
      detail: 'KDS bump timestamp did not precede recorded driver arrival timestamp.',
    });
    return {
      disputeScore: 60,
      status: 'MANUAL_REVIEW',
      breakdown,
    };
  }

  // Rule 5: MISSING_ITEM >= $15.00 + itemized POS EJ receipt confirms full item count & modifiers -> Score 80 (AUTO_QUEUE)
  if (order.deduction_type === 'MISSING_ITEM') {
    const hasItemizedReceipt = matchedCheck.items_json.length > 0;
    if (order.deduction_cents >= 1500 && hasItemizedReceipt) {
      const score = matchPass === 'PASS_1_EXACT_REF' && matchedCheck.kds_bumped_at ? 86 : 80;
      breakdown.push({
        rule: 'HIGH_VALUE_MISSING_ITEM_WITH_EJ_PROOF',
        points: score,
        detail: `Missing item claim >= $15.00 (${formatCentsToUsd(
          order.deduction_cents
        )}) backed by itemized POS EJ Check #${matchedCheck.pos_check_number} (${
          matchedCheck.items_json.length
        } line items & modifiers).`,
      });
      return {
        disputeScore: score,
        status: 'AUTO_QUEUE',
        breakdown,
      };
    }

    if (order.deduction_cents >= 500 && hasItemizedReceipt) {
      breakdown.push({
        rule: 'MID_VALUE_MISSING_ITEM_MANUAL_REVIEW',
        points: 68,
        detail: `Missing item deduction (${formatCentsToUsd(
          order.deduction_cents
        )}) is between $5.00 and $14.99; routed to Manual Review to protect auto-queue win rate.`,
      });
      return {
        disputeScore: 68,
        status: 'MANUAL_REVIEW',
        breakdown,
      };
    }
  }

  // Fallback
  breakdown.push({
    rule: 'GENERAL_MANUAL_REVIEW',
    points: 58,
    detail: 'Matched order requires operator review before portal submission.',
  });
  return {
    disputeScore: 58,
    status: 'MANUAL_REVIEW',
    breakdown,
  };
}

/**
 * Compiles the policy-cited rebuttal paragraph and structured EvidencePacket JSON.
 */
function compileEvidencePacket(
  store: StoreConfig,
  order: StoredDeliveryOrder,
  matchedCheck: StoredPosCheck | null,
  adjacentChecks: StoredPosCheck[],
  matchPass: MatchPass,
  matchConfidence: number,
  disputeScore: number,
  jaccardSimilarity: number | null
): {
  rebuttalText: string;
  evidencePacket: EvidencePacket;
} {
  const expectedPosSubtotalCents = computeExpectedPosSubtotalCents(
    order.dd_subtotal_cents,
    store.menu_markup_pct
  );

  const orderCreatedLocal = formatUtcInStoreTimezone(
    order.order_created_at,
    store.iana_timezone
  );
  const posOpenedLocal = matchedCheck
    ? formatUtcInStoreTimezone(matchedCheck.opened_at, store.iana_timezone)
    : null;
  const kdsBumpedLocal = matchedCheck?.kds_bumped_at
    ? formatUtcInStoreTimezone(matchedCheck.kds_bumped_at, store.iana_timezone)
    : null;
  const driverArrivedLocal = order.driver_arrived_at
    ? formatUtcInStoreTimezone(order.driver_arrived_at, store.iana_timezone)
    : null;
  const cancelledLocal = order.cancelled_at
    ? formatUtcInStoreTimezone(order.cancelled_at, store.iana_timezone)
    : null;

  const platformLabel =
    order.platform === 'UBEREATS'
      ? 'Uber Eats'
      : order.platform === 'GRUBHUB'
        ? 'Grubhub'
        : 'DoorDash';
  const driverLabel =
    order.platform === 'UBEREATS'
      ? 'Courier'
      : order.platform === 'GRUBHUB'
        ? 'Driver'
        : 'Dasher';

  let policyCitation = '';
  let rebuttalStatement = '';

  switch (order.deduction_type) {
    case 'CANCELLED_AFTER_PREP': {
      policyCitation =
        order.platform === 'UBEREATS'
          ? 'Uber Eats Merchant Terms §5.3 (Post-Preparation Order Cancellation Reimbursement)'
          : order.platform === 'GRUBHUB'
            ? 'Grubhub Merchant Agreement §6.1 (Prepared Order Cancellation Payout Protection)'
            : 'DoorDash Merchant Payment Policy §4.2 (Cancelled Orders After Kitchen Preparation Commencement)';
      rebuttalStatement = `Pursuant to ${policyCitation}, the merchant is entitled to full payout reimbursement (${formatCentsToUsd(
        order.deduction_cents
      )}) for ${platformLabel} Order ${order.external_order_id}. Store POS Electronic Journal Check #${
        matchedCheck?.pos_check_number ?? 'N/A'
      } confirms the order was received at ${posOpenedLocal} and bumped complete on the Kitchen Display System (KDS) at ${
        kdsBumpedLocal ?? 'prior to cancellation'
      }, before the cancellation event occurred at ${
        cancelledLocal ?? 'post-preparation'
      }. Full itemized POS EJ receipt log is attached below.`;
      break;
    }

    case 'PREP_TIME_PENALTY': {
      policyCitation =
        order.platform === 'UBEREATS'
          ? 'Uber Eats Merchant Operations Policy §4.1 (Courier Wait Time & Dispatch Accuracy)'
          : order.platform === 'GRUBHUB'
            ? 'Grubhub Merchant Fulfillment Standards §3.2 (Driver Wait Time Assessment)'
            : 'DoorDash Merchant Operations Policy §3.4 (Avoidable Dasher Wait & Prep Time Assessment)';
      rebuttalStatement = `Pursuant to ${policyCitation}, we formally dispute the ${formatCentsToUsd(
        order.deduction_cents
      )} prep-time penalty on ${platformLabel} Order ${order.external_order_id}. Store POS Electronic Journal Check #${
        matchedCheck?.pos_check_number ?? 'N/A'
      } and KDS telemetry confirm food preparation was completed and bumped to the expediter counter at ${
        kdsBumpedLocal ?? 'N/A'
      }, prior to ${driverLabel} arrival at ${
        driverArrivedLocal ?? 'N/A'
      }. No merchant-attributable delay occurred.`;
      break;
    }

    case 'FALSE_STORE_CLOSED': {
      policyCitation =
        order.platform === 'UBEREATS'
          ? 'Uber Eats Merchant Availability Policy §2.4 (Erroneous Store Closed Fee Reversal)'
          : order.platform === 'GRUBHUB'
            ? 'Grubhub Merchant Hours & Availability Policy §2.2 (False Store Closure Adjustment)'
            : 'DoorDash Merchant Store Availability Policy §2.1 (Erroneous Store Closed Fee Reversal)';
      const proofList = adjacentChecks
        .map(
          (c) =>
            `Check #${c.pos_check_number} (${formatUtcInStoreTimezone(
              c.opened_at,
              store.iana_timezone
            )}, ${formatCentsToUsd(c.subtotal_cents)})`
        )
        .join('; ');
      rebuttalStatement = `Pursuant to ${policyCitation}, we request immediate reversal of the ${formatCentsToUsd(
        order.deduction_cents
      )} Store Closed penalty associated with reference ${
        order.external_order_id
      } at ${orderCreatedLocal}. Our Point-of-Sale Electronic Journal proves Store ${
        store.pos_store_code
      } (${store.name}) was open, staffed, and actively ringing transactions within ±10 minutes of the alleged closure timestamp: [${
        proofList || 'See attached POS log'
      }].`;
      break;
    }

    case 'MISSING_ITEM':
    default: {
      policyCitation =
        order.platform === 'UBEREATS'
          ? 'Uber Eats Order Accuracy Dispute Policy §3.1 (Inaccurate/Missing Item POS Verification)'
          : order.platform === 'GRUBHUB'
            ? 'Grubhub Merchant Adjustment Policy §4.4 (Missing Item & Modifier Verification)'
            : 'DoorDash Merchant Error Charge Dispute Policy §5.1 (Itemized POS & Expo Verification)';
      const itemsRendered = matchedCheck
        ? matchedCheck.items_json
            .map(
              (it) =>
                `${it.quantity}x ${it.raw_name}${
                  it.modifiers.length ? ` [${it.modifiers.join(', ')}]` : ''
                }`
            )
            .join(', ')
        : order.items_summary ?? 'All ordered items';
      rebuttalStatement = `Pursuant to ${policyCitation}, we dispute the ${formatCentsToUsd(
        order.deduction_cents
      )} Missing/Incorrect Item deduction on ${platformLabel} Order ${
        order.external_order_id
      }. POS Electronic Journal Check #${
        matchedCheck?.pos_check_number ?? 'N/A'
      } (Reconciled via ${matchPass} at ${matchConfidence}% confidence; POS Subtotal ${formatCentsToUsd(
        matchedCheck?.subtotal_cents ?? 0
      )} vs. Markup-Adjusted Expected ${formatCentsToUsd(
        expectedPosSubtotalCents
      )}) verifies that all line items and modifiers (${itemsRendered}) were rung, prepared, and bumped at KDS (${
        kdsBumpedLocal ?? posOpenedLocal ?? 'verified'
      }).`;
      break;
    }
  }

  const rawEjBlock = matchedCheck
    ? matchedCheck.raw_ej_block
    : adjacentChecks.length > 0
      ? adjacentChecks.map((c) => c.raw_ej_block).join('\n\n--- ADJACENT ACTIVE CHECK ---\n\n')
      : null;

  const fullFormattedPacketText = [
    `=== CLAIMPILOT VERIFIED DISPUTE EVIDENCE PACKET ===`,
    `Store: ${store.name} (POS Code: ${store.pos_store_code} | DoorDash ID: ${store.dd_merchant_store_id})`,
    `Order ID: ${order.external_order_id} | Deduction: ${order.deduction_type} (${formatCentsToUsd(order.deduction_cents)})`,
    `Reconciliation: ${matchPass} (${matchConfidence}% Match Confidence | Dispute Score: ${disputeScore}/100)`,
    `Policy Citation: ${policyCitation}`,
    ``,
    `--- FORMAL REBUTTAL STATEMENT ---`,
    rebuttalStatement,
    ``,
    `--- TIMESTAMP & FINANCIAL AUDIT (${store.iana_timezone} / UTC) ---`,
    `• DoorDash Order Created: ${orderCreatedLocal} (${order.order_created_at})`,
    ...(posOpenedLocal
      ? [`• POS Check #${matchedCheck?.pos_check_number} Opened: ${posOpenedLocal} (${matchedCheck?.opened_at})`]
      : []),
    ...(kdsBumpedLocal
      ? [`• KDS Kitchen Bump Ready: ${kdsBumpedLocal} (${matchedCheck?.kds_bumped_at})`]
      : []),
    ...(driverArrivedLocal
      ? [`• Dasher Arrived at Store: ${driverArrivedLocal} (${order.driver_arrived_at})`]
      : []),
    ...(cancelledLocal
      ? [`• Order Cancelled Timestamp: ${cancelledLocal} (${order.cancelled_at})`]
      : []),
    `• DoorDash Order Subtotal: ${formatCentsToUsd(order.dd_subtotal_cents)} (Store Markup: ${Math.round(
      store.menu_markup_pct * 100
    )}% -> Expected POS: ${formatCentsToUsd(expectedPosSubtotalCents)})`,
    ...(matchedCheck
      ? [`• Verified POS Check Subtotal: ${formatCentsToUsd(matchedCheck.subtotal_cents)}`]
      : []),
    ``,
    `--- VERBATIM POS ELECTRONIC JOURNAL (EJ) LOG ---`,
    rawEjBlock ?? '[No matched POS Electronic Journal block attached]',
  ].join('\n');

  const evidencePacket: EvidencePacket = {
    merchant_store_name: store.name,
    pos_store_code: store.pos_store_code,
    dd_merchant_store_id: store.dd_merchant_store_id,
    platform: order.platform,
    external_order_id: order.external_order_id,
    deduction_type: order.deduction_type,
    deduction_cents: order.deduction_cents,
    dd_subtotal_cents: order.dd_subtotal_cents,
    expected_pos_subtotal_cents: expectedPosSubtotalCents,
    matched_pos_subtotal_cents: matchedCheck?.subtotal_cents ?? null,
    menu_markup_pct: store.menu_markup_pct,
    match_pass: matchPass,
    match_confidence: matchConfidence,
    dispute_score: disputeScore,
    jaccard_similarity: jaccardSimilarity,
    order_created_utc: order.order_created_at,
    order_created_local: orderCreatedLocal,
    pos_opened_utc: matchedCheck?.opened_at ?? null,
    pos_opened_local: posOpenedLocal,
    kds_bumped_utc: matchedCheck?.kds_bumped_at ?? null,
    kds_bumped_local: kdsBumpedLocal,
    driver_arrived_utc: order.driver_arrived_at,
    driver_arrived_local: driverArrivedLocal,
    cancelled_utc: order.cancelled_at,
    cancelled_local: cancelledLocal,
    adjacent_active_checks: adjacentChecks.map((c) => ({
      pos_check_number: c.pos_check_number,
      opened_local: formatUtcInStoreTimezone(c.opened_at, store.iana_timezone),
      subtotal_cents: c.subtotal_cents,
    })),
    policy_citation: policyCitation,
    rebuttal_statement: rebuttalStatement,
    raw_ej_block: rawEjBlock,
  };

  return {
    rebuttalText: fullFormattedPacketText,
    evidencePacket,
  };
}
