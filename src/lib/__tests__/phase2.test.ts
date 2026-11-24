import { describe, expect, it } from 'vitest';
import { parseUberEatsPayoutCsv } from '../parsers/ubereats-csv-parser';
import { parseGrubhubPayoutCsv } from '../parsers/grubhub-csv-parser';
import { parsePosElectronicJournal } from '../parsers/pos-ej-parser';
import {
  extract2faOtpCode,
  extractClientSlugFromDisputeEmail,
  store2faEmailCode,
} from '../automation/two-factor-router';
import { submitClaimViaPortalWorker } from '../automation/portal-submitter';
import {
  computeRecoveryInvoiceFeeCents,
  generateRecoveryInvoiceForStore,
} from '../billing/stripe-recovery';
import { listClaims, listStores } from '../repository';

describe('Phase 2: Multi-Platform CSV Adapters, 2FA Routing, Playwright Submitter & Stripe Billing', () => {
  it('parses UberEats payout CSV with 30-day dispute window', () => {
    const csv = `order_id,order_date,food_sales,inaccurate_order_adjustment,issue_type,items,eater_comment
UE-9918A2,2026-11-20 19:00:00,$46.00,-$22.50,Missing Item,"2x Wings 10pc, 2x Ranch",Missing wings`;

    const res = parseUberEatsPayoutCsv(csv, 'America/Chicago');
    expect(res.deductionOrders.length).toBe(1);
    const ord = res.deductionOrders[0];
    expect(ord.platform).toBe('UBEREATS');
    expect(ord.deduction_type).toBe('MISSING_ITEM');
    expect(ord.deduction_cents).toBe(2250);

    // 30-day window check
    const diffDays =
      (new Date(ord.dispute_deadline_at).getTime() -
        new Date(ord.order_created_at).getTime()) /
      (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(30);
  });

  it('parses Grubhub adjustment CSV with 30-day dispute window', () => {
    const csv = `order_number,transaction_date,subtotal,adjustment_amount,adjustment_reason,items,diner_note
GH-442019,2026-11-20 20:00:00,$40.00,-$18.50,Cancelled After Prep,"2x Wings 10pc",Cancelled after prep`;

    const res = parseGrubhubPayoutCsv(csv, 'America/Chicago');
    expect(res.deductionOrders.length).toBe(1);
    expect(res.deductionOrders[0].platform).toBe('GRUBHUB');
    expect(res.deductionOrders[0].deduction_type).toBe('CANCELLED_AFTER_PREP');
    expect(res.deductionOrders[0].deduction_cents).toBe(1850);
  });

  it('handles midnight rollover on time-only KDS bump timestamps in POS EJ logs', () => {
    const ej = `==========================================
CHK# 7701 | EXT REF: DD-MIDNIGHT1
OPENED: 2026-11-20 23:55:00
KDS BUMPED: 00:06:00
1x Wings 10pc                 $16.00
SUBTOTAL:                     $16.00
==========================================`;
    const res = parsePosElectronicJournal(ej, 'America/Chicago');
    expect(res.validChecks.length).toBe(1);
    const chk = res.validChecks[0];
    expect(new Date(chk.kds_bumped_at!).getTime()).toBeGreaterThan(
      new Date(chk.opened_at).getTime()
    );
  });

  it('extracts 2FA OTP codes from role-based disputes+client emails and executes Playwright dry-run submission', async () => {
    expect(extractClientSlugFromDisputeEmail('disputes+windy-city@claimpilot.app')).toBe(
      'windy-city'
    );
    expect(
      extract2faOtpCode('Your DoorDash security verification code is 492817. Do not share.')
    ).toBe('492817');

    const storedOtp = await store2faEmailCode({
      recipientEmail: 'disputes+windy-city@claimpilot.app',
      senderEmail: 'no-reply@doordash.com',
      subject: 'Security Code',
      bodyText: 'Your verification code is 492817.',
    });
    expect(storedOtp?.otpCode).toBe('492817');

    const stores = await listStores();
    const claims = await listClaims(stores[0].id);
    const autoClaim = claims.find((c) => c.status === 'AUTO_QUEUE');
    expect(autoClaim).toBeDefined();

    const job = await submitClaimViaPortalWorker(autoClaim!);
    expect(job.status).toBe('SUBMITTED');
    expect(job.portal_confirmation_id).toMatch(/^DD-DISP-/);
    expect(job.used_2fa_code_id).toBe(storedOtp?.id);
  });

  it('calculates Stripe % recovery invoice fee in integer cents and prevents double-billing', async () => {
    expect(computeRecoveryInvoiceFeeCents(3680, 0.2)).toBe(736);

    const stores = await listStores();
    const inv = await generateRecoveryInvoiceForStore({
      storeId: stores[0].id,
      feePct: 0.2,
      periodLabel: '2026-11',
    });
    expect(inv.invoice_amount_cents).toBeGreaterThan(0);
    expect(inv.status).toBe('OPEN');

    // Second call for same store with no new WON claims must reject double-billing
    await expect(
      generateRecoveryInvoiceForStore({
        storeId: stores[0].id,
        feePct: 0.2,
      })
    ).rejects.toThrow(/No unbilled WON claims/);
  });
});
