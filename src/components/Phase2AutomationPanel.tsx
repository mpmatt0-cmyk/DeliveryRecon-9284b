'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  CreditCard,
  KeyRound,
  Play,
  Receipt,
  RefreshCw,
  Send,
} from 'lucide-react';
import {
  Dispute2faCodeRecord,
  RecoveryInvoiceRecord,
  StoreConfig,
  SubmissionJobRecord,
} from '@/lib/types';

function formatUsd(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `$${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

export function Phase2AutomationPanel({
  selectedStoreId,
  stores,
  autoQueuedCount,
  onDataChanged,
  onNotify,
}: {
  selectedStoreId: string;
  stores: StoreConfig[];
  autoQueuedCount: number;
  onDataChanged: () => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  const [jobs, setJobs] = useState<SubmissionJobRecord[]>([]);
  const [codes, setCodes] = useState<Dispute2faCodeRecord[]>([]);
  const [invoices, setInvoices] = useState<RecoveryInvoiceRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const loadPhase2State = useCallback(async () => {
    const [jobsRes, codesRes, invRes] = await Promise.all([
      fetch(`/api/submissions?storeId=${encodeURIComponent(selectedStoreId)}`),
      fetch('/api/webhooks/dispute-2fa'),
      fetch(`/api/billing?storeId=${encodeURIComponent(selectedStoreId)}`),
    ]);
    const [jobsJson, codesJson, invJson] = await Promise.all([
      jobsRes.json(),
      codesRes.json(),
      invRes.json(),
    ]);
    if (jobsJson.jobs) setJobs(jobsJson.jobs);
    if (codesJson.codes) setCodes(codesJson.codes);
    if (invJson.invoices) setInvoices(invJson.invoices);
  }, [selectedStoreId]);

  useEffect(() => {
    loadPhase2State();
  }, [loadPhase2State]);

  const handleSimulate2fa = async () => {
    setBusy('2fa');
    try {
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const res = await fetch('/api/webhooks/dispute-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: 'disputes+windy-city@claimpilot.app',
          from: 'no-reply@doordash.com',
          subject: 'DoorDash Merchant Portal Security Verification',
          text: `Your DoorDash Merchant Portal verification code is ${otp}. Valid for 15 minutes.`,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onNotify(`Captured 2FA OTP ${data.otpCode} at disputes+${data.clientSlug}@claimpilot.app`);
        await loadPhase2State();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleBatchSubmit = async () => {
    setBusy('submit');
    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId: selectedStoreId,
          batchAutoQueue: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onNotify(
          `Playwright Worker submitted ${data.submittedCount} AUTO_QUEUE claim(s) to delivery portals`
        );
        await Promise.all([loadPhase2State(), onDataChanged()]);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleGenerateInvoice = async () => {
    const targetStoreId =
      selectedStoreId !== 'ALL' ? selectedStoreId : stores[0]?.id;
    if (!targetStoreId) return;

    setBusy('invoice');
    try {
      const res = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId: targetStoreId,
          feePct: 0.2,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(`Billing: ${data.error}`);
      } else {
        onNotify(
          `Generated Stripe Recovery Invoice ${data.invoice.stripe_invoice_id} for ${formatUsd(
            data.invoice.invoice_amount_cents
          )}`
        );
        await loadPhase2State();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-indigo-500/30 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">
              Phase 2 Automation: 2FA Email Routing, Playwright Portal Submitter &amp; Stripe % Recovery Billing
            </h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Role-based 2FA inbox (<code>disputes+windy-city@claimpilot.app</code>), session-authenticated
            auto-submission, and automated 20% recovery fee invoicing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSimulate2fa}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            <KeyRound className="h-3.5 w-3.5 text-amber-400" />
            Simulate 2FA OTP Email
          </button>
          <button
            onClick={handleBatchSubmit}
            disabled={busy !== null || autoQueuedCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            Auto-Submit {autoQueuedCount} Queued Claim{autoQueuedCount === 1 ? '' : 's'}
          </button>
          <button
            onClick={handleGenerateInvoice}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <CreditCard className="h-3.5 w-3.5" />
            Generate 20% Recovery Invoice
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Column 1: 2FA OTP Inbox */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-300">
            <span className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              2FA Email Router Inbox
            </span>
            <span className="text-[11px] text-slate-400">{codes.length} codes</span>
          </div>
          {codes.length === 0 ? (
            <p className="text-[11px] text-slate-500 py-3">
              No 2FA OTP codes captured yet. Click &ldquo;Simulate 2FA OTP Email&rdquo; or POST to{' '}
              <code>/api/webhooks/dispute-2fa</code>.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {codes.slice(0, 5).map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-[11px]"
                >
                  <div>
                    <span className="font-mono font-bold text-amber-300">{c.otp_code}</span>{' '}
                    <span className="text-slate-400">• {c.platform}</span>
                    <div className="text-[10px] text-slate-500">{c.recipient_email}</div>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      c.consumed
                        ? 'bg-slate-800 text-slate-400'
                        : 'bg-emerald-500/15 text-emerald-300'
                    }`}
                  >
                    {c.consumed ? 'CONSUMED' : 'ACTIVE'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Column 2: Playwright Submission Jobs */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-indigo-300">
            <span className="flex items-center gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Playwright Portal Jobs
            </span>
            <span className="text-[11px] text-slate-400">{jobs.length} runs</span>
          </div>
          {jobs.length === 0 ? (
            <p className="text-[11px] text-slate-500 py-3">
              No automated portal submissions dispatched yet.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {jobs.slice(0, 5).map((j) => (
                <div
                  key={j.id}
                  className="rounded border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-[11px]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-white">
                      {j.external_order_id ?? j.claim_id}
                    </span>
                    <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
                      {j.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {j.platform} • Conf: <code>{j.portal_confirmation_id ?? 'N/A'}</code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Column 3: Stripe % Recovery Invoices */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-emerald-300">
            <span className="flex items-center gap-1.5">
              <Receipt className="h-3.5 w-3.5" />
              Stripe Recovery Invoices
            </span>
            <button
              onClick={loadPhase2State}
              className="text-slate-400 hover:text-white"
              title="Refresh Phase 2 status"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {invoices.length === 0 ? (
            <p className="text-[11px] text-slate-500 py-3">
              No recovery invoices generated yet. Click &ldquo;Generate 20% Recovery Invoice&rdquo;
              to bill uninvoiced WON claims.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-[11px]"
                >
                  <div>
                    <div className="font-mono font-semibold text-white">
                      {formatUsd(inv.invoice_amount_cents)}{' '}
                      <span className="text-[10px] font-normal text-slate-400">
                        ({Math.round(inv.fee_pct * 100)}% of {formatUsd(inv.total_recovered_cents)})
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {inv.stripe_invoice_id} • {inv.won_claims_count} won claim(s)
                    </div>
                  </div>
                  <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                    {inv.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
