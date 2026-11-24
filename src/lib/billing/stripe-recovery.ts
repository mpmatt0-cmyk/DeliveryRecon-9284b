import crypto from 'crypto';
import { getDb } from '@/lib/db';
import { getStoreById, listClaims } from '@/lib/repository';
import { RecoveryInvoiceRecord } from '@/lib/types';

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function computeRecoveryInvoiceFeeCents(
  totalRecoveredCents: number,
  feePct: number
): number {
  if (totalRecoveredCents <= 0 || feePct <= 0) return 0;
  return Math.round(totalRecoveredCents * feePct);
}

/**
 * Generates a % Recovery Invoice for unbilled WON claims at a store.
 * Uses Stripe REST API if `STRIPE_SECRET_KEY` and `stripeCustomerId` are configured,
 * or deterministic `LEDGER_DRY_RUN` mode otherwise.
 */
export async function generateRecoveryInvoiceForStore(input: {
  storeId: string;
  feePct?: number;
  periodLabel?: string;
  stripeCustomerId?: string;
}): Promise<RecoveryInvoiceRecord> {
  const db = await getDb();
  const store = await getStoreById(input.storeId);
  if (!store) throw new Error(`Store not found: ${input.storeId}`);

  const feePct = input.feePct ?? store.recovery_fee_pct ?? 0.2;
  const periodLabel =
    input.periodLabel || new Date().toISOString().slice(0, 7); // YYYY-MM

  // Collect all previously invoiced claim IDs to prevent double-billing
  const existingInvoices = await listRecoveryInvoices(store.id);
  const alreadyBilledClaimIds = new Set<string>();
  for (const inv of existingInvoices) {
    if (inv.status !== 'VOID') {
      for (const cid of inv.claim_ids) alreadyBilledClaimIds.add(cid);
    }
  }

  const storeClaims = await listClaims(store.id);
  const billableClaims = storeClaims.filter(
    (c) =>
      c.status === 'WON' &&
      c.verified_recovered_cents > 0 &&
      !alreadyBilledClaimIds.has(c.id)
  );

  if (billableClaims.length === 0) {
    throw new Error('No unbilled WON claims with verified recovered dollars for this store.');
  }

  const totalRecoveredCents = billableClaims.reduce(
    (sum, c) => sum + c.verified_recovered_cents,
    0
  );
  const invoiceAmountCents = computeRecoveryInvoiceFeeCents(totalRecoveredCents, feePct);
  const claimIds = billableClaims.map((c) => c.id);
  const id = makeId('inv');
  const clientSlug = store.client_slug || 'windy-city';

  let stripeInvoiceId: string | null = null;
  let hostedInvoiceUrl: string | null = null;
  let stripeMode: 'STRIPE_API' | 'LEDGER_DRY_RUN' = 'LEDGER_DRY_RUN';

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (stripeSecret && input.stripeCustomerId) {
    stripeMode = 'STRIPE_API';
    const invRes = await fetch('https://api.stripe.com/v1/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: input.stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: '14',
        description: `ClaimPilot ${Math.round(feePct * 100)}% Recovery Fee (${periodLabel}) — ${store.name}`,
      }),
    });
    if (!invRes.ok) {
      throw new Error(`Stripe invoice creation failed: ${await invRes.text()}`);
    }
    const invJson = (await invRes.json()) as {
      id: string;
      hosted_invoice_url?: string;
    };
    stripeInvoiceId = invJson.id;
    hostedInvoiceUrl = invJson.hosted_invoice_url ?? null;

    await fetch('https://api.stripe.com/v1/invoiceitems', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: input.stripeCustomerId,
        invoice: stripeInvoiceId,
        amount: String(invoiceAmountCents),
        currency: 'usd',
        description: `Verified delivery chargeback recovery (${billableClaims.length} won claims totaling $${(
          totalRecoveredCents / 100
        ).toFixed(2)})`,
      }),
    });
  } else {
    stripeInvoiceId = `in_demo_${crypto.randomBytes(6).toString('hex')}`;
  }

  await db.query(
    `INSERT INTO recovery_invoices (
      id, store_id, client_slug, stripe_invoice_id, stripe_mode,
      period_label, won_claims_count, total_recovered_cents,
      fee_pct, invoice_amount_cents, claim_ids, status, hosted_invoice_url
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'OPEN', $12)`,
    [
      id,
      store.id,
      clientSlug,
      stripeInvoiceId,
      stripeMode,
      periodLabel,
      billableClaims.length,
      totalRecoveredCents,
      feePct,
      invoiceAmountCents,
      JSON.stringify(claimIds),
      hostedInvoiceUrl,
    ]
  );

  return {
    id,
    store_id: store.id,
    store_name: store.name,
    client_slug: clientSlug,
    stripe_invoice_id: stripeInvoiceId,
    stripe_mode: stripeMode,
    period_label: periodLabel,
    won_claims_count: billableClaims.length,
    total_recovered_cents: totalRecoveredCents,
    fee_pct: feePct,
    invoice_amount_cents: invoiceAmountCents,
    claim_ids: claimIds,
    status: 'OPEN',
    hosted_invoice_url: hostedInvoiceUrl,
    created_at: new Date().toISOString(),
  };
}

export async function listRecoveryInvoices(
  storeId?: string
): Promise<RecoveryInvoiceRecord[]> {
  const db = await getDb();
  const params: unknown[] = [];
  const where = storeId && storeId !== 'ALL' ? `WHERE r.store_id = $1` : '';
  if (storeId && storeId !== 'ALL') params.push(storeId);

  const res = await db.query<Record<string, unknown>>(
    `SELECT r.*, s.name AS store_name
     FROM recovery_invoices r
     JOIN stores s ON s.id = r.store_id
     ${where}
     ORDER BY r.created_at DESC`,
    params
  );

  return res.rows.map((r) => ({
    id: String(r.id),
    store_id: String(r.store_id),
    store_name: r.store_name ? String(r.store_name) : undefined,
    client_slug: String(r.client_slug),
    stripe_invoice_id: r.stripe_invoice_id ? String(r.stripe_invoice_id) : null,
    stripe_mode: r.stripe_mode as RecoveryInvoiceRecord['stripe_mode'],
    period_label: String(r.period_label),
    won_claims_count: Number(r.won_claims_count),
    total_recovered_cents: Number(r.total_recovered_cents),
    fee_pct: Number(r.fee_pct),
    invoice_amount_cents: Number(r.invoice_amount_cents),
    claim_ids:
      typeof r.claim_ids === 'string'
        ? JSON.parse(r.claim_ids)
        : (r.claim_ids as string[]),
    status: r.status as RecoveryInvoiceRecord['status'],
    hosted_invoice_url: r.hosted_invoice_url ? String(r.hosted_invoice_url) : null,
    created_at: new Date(String(r.created_at)).toISOString(),
  }));
}
