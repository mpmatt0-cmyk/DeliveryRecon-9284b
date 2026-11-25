'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  DollarSign,
  FileSpreadsheet,
  FileText,
  Filter,
  Mail,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { ClaimRowView } from '@/lib/repository';
import { ClaimStatus, IngestionLogRecord, StoreConfig } from '@/lib/types';
import { Phase2AutomationPanel } from './Phase2AutomationPanel';

function formatUsd(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

function getHoursRemaining(deadlineIso: string): number {
  const diffMs = new Date(deadlineIso).getTime() - Date.now();
  return Math.round(diffMs / (1000 * 60 * 60));
}

const SAMPLE_POS_EJ_DROP = `==========================================
CHK# 9201 | EXT REF: DOORDASH #DD-7741F3A9
OPENED: 2026-11-22 19:12:00
KDS BUMPED: 2026-11-22 19:21:40
CLOSED: 2026-11-22 19:23:00
2x Wings 10pc                 $31.00
  + Mango Habanero
  + 2x Side Ranch
1x Mozzarella Sticks          $9.00
SUBTOTAL:                     $40.00
TAX:                          $4.10
TOTAL:                        $44.10
==========================================`;

const SAMPLE_DD_CSV_DROP = `order_id,order_created_at,cancelled_at,driver_arrived_at,subtotal,error_charge,transaction_type,items,customer_note
DD-7741F3A9,2026-11-22 19:10:00,2026-11-22 19:26:30,,$46.00,-$46.00,Cancelled After Prep,"2x Wings 10pc, 2x Ranch, 1x Mozzarella Sticks",Order cancelled by customer after KDS bump`;

export function ClaimPilotDashboard() {
  const [stores, setStores] = useState<StoreConfig[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>('ALL');
  const [claims, setClaims] = useState<ClaimRowView[]>([]);
  const [ingestionLogs, setIngestionLogs] = useState<IngestionLogRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [activeClaim, setActiveClaim] = useState<ClaimRowView | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modals & drawers
  const [showStoreModal, setShowStoreModal] = useState<boolean>(false);
  const [showUploadPanel, setShowUploadPanel] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Store creation form state
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreCode, setNewStoreCode] = useState('');
  const [newStoreDdId, setNewStoreDdId] = useState('');
  const [newStoreTz, setNewStoreTz] = useState('America/Chicago');
  const [newStoreMarkup, setNewStoreMarkup] = useState('15');

  // Uploader state
  const [uploadStoreId, setUploadStoreId] = useState<string>('store_chi_104');
  const [uploadFileType, setUploadFileType] = useState<
    'POS_EJ' | 'DOORDASH_CSV' | 'UBEREATS_CSV' | 'GRUBHUB_CSV'
  >('POS_EJ');
  const [uploadFilename, setUploadFilename] = useState<string>('nightly_ej_export.log');
  const [uploadContent, setUploadContent] = useState<string>(SAMPLE_POS_EJ_DROP);
  const [uploading, setUploading] = useState<boolean>(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const fetchDashboardData = useCallback(async (storeFilter: string) => {
    setLoading(true);
    try {
      let localCustomStores: StoreConfig[] = [];
      try {
        const rawLocal = window.localStorage.getItem('claimpilot_custom_stores_v1');
        if (rawLocal) {
          localCustomStores = JSON.parse(rawLocal) as StoreConfig[];
        }
      } catch {
        // ignore localStorage read errors
      }

      const res = await fetch(`/api/claims?storeId=${encodeURIComponent(storeFilter)}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.stores) {
        const fetchedStores: StoreConfig[] = data.stores;
        const serverCodes = new Set(
          fetchedStores.map((s) => s.pos_store_code.toUpperCase())
        );

        // Re-hydrate any locally saved custom stores that this serverless container doesn't have yet
        for (const custom of localCustomStores) {
          if (!serverCodes.has(custom.pos_store_code.toUpperCase())) {
            fetch('/api/stores', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(custom),
            }).catch(() => {});
          }
        }

        setStores((prev) => {
          const map = new Map<string, StoreConfig>();
          for (const s of prev) map.set(s.pos_store_code.toUpperCase(), s);
          for (const s of fetchedStores) map.set(s.pos_store_code.toUpperCase(), s);
          for (const s of localCustomStores) map.set(s.pos_store_code.toUpperCase(), s);
          return Array.from(map.values());
        });
        if (fetchedStores.length > 0) {
          setUploadStoreId((prev) =>
            prev && prev !== 'ALL' ? prev : fetchedStores[0].id
          );
        }
      }
      if (data.claims) setClaims(data.claims);
      if (data.ingestionLogs) setIngestionLogs(data.ingestionLogs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData(selectedStoreId);
  }, [selectedStoreId, fetchDashboardData]);

  // Compute 4 KPI Strip metrics
  const kpis = useMemo(() => {
    let totalUncontestedCents = 0;
    let totalUncontestedCount = 0;

    let autoQueuedCents = 0;
    let autoQueuedCount = 0;

    let expiring72hCents = 0;
    let expiring72hCount = 0;

    let verifiedRecoveredCents = 0;
    let verifiedRecoveredCount = 0;

    for (const c of claims) {
      const isUncontested = c.status === 'AUTO_QUEUE' || c.status === 'MANUAL_REVIEW';
      if (isUncontested) {
        totalUncontestedCents += c.deduction_cents;
        totalUncontestedCount++;

        const hoursLeft = getHoursRemaining(c.dispute_deadline_at);
        if (hoursLeft > 0 && hoursLeft <= 72) {
          expiring72hCents += c.deduction_cents;
          expiring72hCount++;
        }
      }

      if (c.status === 'AUTO_QUEUE') {
        autoQueuedCents += c.deduction_cents;
        autoQueuedCount++;
      }

      if (c.status === 'WON') {
        verifiedRecoveredCents += c.verified_recovered_cents || c.deduction_cents;
        verifiedRecoveredCount++;
      }
    }

    return {
      totalUncontestedCents,
      totalUncontestedCount,
      autoQueuedCents,
      autoQueuedCount,
      expiring72hCents,
      expiring72hCount,
      verifiedRecoveredCents,
      verifiedRecoveredCount,
    };
  }, [claims]);

  const filteredClaims = useMemo(() => {
    if (statusFilter === 'ALL') return claims;
    if (statusFilter === 'EXPIRING_72H') {
      return claims.filter((c) => {
        const hrs = getHoursRemaining(c.dispute_deadline_at);
        return (c.status === 'AUTO_QUEUE' || c.status === 'MANUAL_REVIEW') && hrs > 0 && hrs <= 72;
      });
    }
    return claims.filter((c) => c.status === statusFilter);
  }, [claims, statusFilter]);

  const handleCopyDisputePacket = async (claim: ClaimRowView) => {
    try {
      await navigator.clipboard.writeText(claim.rebuttal_text);
      setCopiedId(claim.id);
      showToast(`Copied policy-cited evidence packet for Order ${claim.external_order_id}`);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      showToast('Clipboard permission blocked; please copy manually from the drawer.');
    }
  };

  const handleUpdateClaimStatus = async (claimId: string, status: ClaimStatus) => {
    await fetch('/api/claims', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimId, status }),
    });
    showToast(`Updated claim status to ${status}`);
    await fetchDashboardData(selectedStoreId);
    if (activeClaim && activeClaim.id === claimId) {
      setActiveClaim((prev) =>
        prev
          ? {
              ...prev,
              status,
              verified_recovered_cents: status === 'WON' ? prev.deduction_cents : 0,
            }
          : null
      );
    }
  };

  const handleFileDropOrSelect = async (file: File) => {
    const text = await file.text();
    const isCsv =
      file.name.toLowerCase().endsWith('.csv') || text.trimStart().startsWith('order_id,');
    setUploadFilename(file.name);
    setUploadFileType(isCsv ? 'DOORDASH_CSV' : 'POS_EJ');
    setUploadContent(text);
  };

  const handleRunManualUpload = async () => {
    if (!uploadStoreId || !uploadContent.trim()) return;
    setUploading(true);
    try {
      const targetStoreConfig = stores.find((s) => s.id === uploadStoreId);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId: uploadStoreId,
          storeConfig: targetStoreConfig,
          fileType: uploadFileType,
          filename: uploadFilename,
          content: uploadContent,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(`Error: ${data.error || 'Upload failed'}`);
      } else {
        showToast(
          `Processed ${uploadFilename}: ${data.recordsParsed} valid record(s), ${data.claimsReconciled} claim(s) reconciled.`
        );
        await fetchDashboardData(selectedStoreId);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleSimulateInboundEmailWebhook = async () => {
    const targetStore =
      stores.find((s) => s.id === uploadStoreId) ?? stores[0];
    if (!targetStore) return;

    setUploading(true);
    try {
      // Simulate both nightly POS EJ email drop + DoorDash CSV drop via /api/webhooks/inbound-email
      await fetch('/api/webhooks/inbound-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: targetStore.inbound_email_address,
          from: `pos-export@${targetStore.pos_store_code.toLowerCase()}.toasttab-mail.com`,
          filename: `${targetStore.pos_store_code}_Nightly_EJ_2026-11-22.log`,
          content: SAMPLE_POS_EJ_DROP,
        }),
      });

      const res = await fetch('/api/webhooks/inbound-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: targetStore.inbound_email_address,
          from: `settlements@doordash.com`,
          filename: `DoorDash_Payout_${targetStore.pos_store_code}_2026-11-22.csv`,
          content: SAMPLE_DD_CSV_DROP,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        showToast(
          `Inbound Email Webhook (${targetStore.inbound_email_address}) ingested & reconciled new $46.00 claim (DD-7741F3A9)!`
        );
        await fetchDashboardData(selectedStoreId);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleSaveNewStore = async (e: React.FormEvent) => {
    e.preventDefault();
    const markupPct = Math.max(0, Number(newStoreMarkup) / 100);
    const res = await fetch('/api/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newStoreName,
        pos_store_code: newStoreCode,
        dd_merchant_store_id: newStoreDdId.trim() || 'N/A',
        iana_timezone: newStoreTz,
        menu_markup_pct: markupPct,
      }),
    });
    const data = await res.json();
    if (res.ok && data.store) {
      const savedStore: StoreConfig = data.store;
      try {
        const rawLocal = window.localStorage.getItem('claimpilot_custom_stores_v1');
        const list: StoreConfig[] = rawLocal ? JSON.parse(rawLocal) : [];
        const nextList = list.filter(
          (s) =>
            s.pos_store_code.toUpperCase() !==
            savedStore.pos_store_code.toUpperCase()
        );
        nextList.push(savedStore);
        window.localStorage.setItem(
          'claimpilot_custom_stores_v1',
          JSON.stringify(nextList)
        );
      } catch {
        // ignore localStorage write errors
      }
      setStores((prev) => {
        const exists = prev.some(
          (s) =>
            s.id === savedStore.id ||
            s.pos_store_code.toUpperCase() === savedStore.pos_store_code.toUpperCase()
        );
        return exists
          ? prev.map((s) =>
              s.id === savedStore.id ||
              s.pos_store_code.toUpperCase() === savedStore.pos_store_code.toUpperCase()
                ? savedStore
                : s
            )
          : [...prev, savedStore];
      });
      setSelectedStoreId(savedStore.id);
      setUploadStoreId(savedStore.id);
      showToast(
        `Saved store ${savedStore.pos_store_code} (${savedStore.inbound_email_address})`
      );
      setNewStoreName('');
      setNewStoreCode('');
      setNewStoreDdId('');
      setShowStoreModal(false);
    } else {
      showToast(`Error: ${data.error || 'Failed to save store'}`);
    }
  };

  const selectedStoreObj = stores.find((s) => s.id === selectedStoreId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Toast Banner */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 rounded-lg border border-emerald-500/40 bg-slate-900/95 px-4 py-3 text-sm font-medium text-emerald-300 shadow-2xl backdrop-blur">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Navigation Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">ClaimPilot</h1>
                <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                  Phase 1 MVP • 3-Pass Engine
                </span>
              </div>
              <p className="text-xs text-slate-400">
                POS Electronic Journal &amp; DoorDash Chargeback Reconciliation Platform
              </p>
            </div>
          </div>

          {/* Store Switcher & Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5">
              <Building2 className="h-4 w-4 text-slate-400" />
              <select
                aria-label="Filter by Store Location"
                value={selectedStoreId}
                onChange={(e) => setSelectedStoreId(e.target.value)}
                className="bg-transparent text-xs font-medium text-slate-200 focus:outline-none"
              >
                <option value="ALL" className="bg-slate-900">
                  All Franchise Locations ({stores.length} Stores)
                </option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-900">
                    {s.pos_store_code} — {s.name} ({s.iana_timezone} •{' '}
                    {Math.round(s.menu_markup_pct * 100)}% Markup)
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => setShowStoreModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition"
            >
              <Plus className="h-3.5 w-3.5 text-emerald-400" />
              Manage Stores
            </button>

            <button
              onClick={() => setShowUploadPanel((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 transition"
            >
              <Upload className="h-3.5 w-3.5" />
              {showUploadPanel ? 'Hide Audit Uploader' : 'Historical Audit Upload & Webhook'}
            </button>
          </div>
        </div>

        {/* Store Dedicated Inbound Email Strip */}
        {selectedStoreObj && (
          <div className="border-t border-slate-800/60 bg-slate-900/50 px-6 py-2">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-emerald-400" />
                <span>Tier 1 Nightly POS EJ Email Drop Address:</span>
                <code className="rounded bg-slate-950 px-2 py-0.5 font-mono text-emerald-300 border border-slate-800">
                  {selectedStoreObj.inbound_email_address}
                </code>
              </div>
              <div className="flex items-center gap-4 text-slate-400">
                <span>
                  DoorDash Store ID:{' '}
                  <strong className="text-slate-200">{selectedStoreObj.dd_merchant_store_id}</strong>
                </span>
                <span>
                  IANA Timezone:{' '}
                  <strong className="text-slate-200">{selectedStoreObj.iana_timezone}</strong>
                </span>
                <span>
                  Menu Markup:{' '}
                  <strong className="text-slate-200">
                    {Math.round(selectedStoreObj.menu_markup_pct * 100)}%
                  </strong>
                </span>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-6 py-6">
        {/* 4-Card Operations KPI Strip */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* 1. Total Uncontested */}
          <div
            onClick={() => setStatusFilter('ALL')}
            className="cursor-pointer rounded-xl border border-slate-800 bg-slate-900/70 p-4 hover:border-slate-700 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Total Uncontested
              </span>
              <div className="rounded-lg bg-amber-500/10 p-2 text-amber-400">
                <DollarSign className="h-4 w-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-white">
                {formatUsd(kpis.totalUncontestedCents)}
              </span>
              <span className="text-xs text-slate-400">
                ({kpis.totalUncontestedCount} open claims)
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              Pending submission across Auto-Queue &amp; Manual Review
            </p>
          </div>

          {/* 2. Auto-Queued (Score >= 80) */}
          <div
            onClick={() => setStatusFilter('AUTO_QUEUE')}
            className="cursor-pointer rounded-xl border border-emerald-500/30 bg-emerald-950/15 p-4 hover:border-emerald-500/50 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-emerald-300">
                Auto-Queued (Score ≥ 80)
              </span>
              <div className="rounded-lg bg-emerald-500/15 p-2 text-emerald-400">
                <Sparkles className="h-4 w-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-emerald-300">
                {formatUsd(kpis.autoQueuedCents)}
              </span>
              <span className="text-xs text-emerald-400/80">
                ({kpis.autoQueuedCount} high-win claims)
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              Passed anti-ban gate with POS EJ &amp; KDS timestamp proof
            </p>
          </div>

          {/* 3. Expiring < 72h */}
          <div
            onClick={() => setStatusFilter('EXPIRING_72H')}
            className="cursor-pointer rounded-xl border border-rose-500/30 bg-rose-950/15 p-4 hover:border-rose-500/50 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-rose-300">
                Expiring &lt; 72 Hours
              </span>
              <div className="rounded-lg bg-rose-500/15 p-2 text-rose-400">
                <Clock className="h-4 w-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-rose-300">
                {formatUsd(kpis.expiring72hCents)}
              </span>
              <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-rose-300">
                {kpis.expiring72hCount} urgent
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              Approaching DoorDash strict 14-day dispute cutoff
            </p>
          </div>

          {/* 4. Verified Recovered */}
          <div
            onClick={() => setStatusFilter('WON')}
            className="cursor-pointer rounded-xl border border-sky-500/30 bg-sky-950/15 p-4 hover:border-sky-500/50 transition"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-sky-300">
                Verified Recovered
              </span>
              <div className="rounded-lg bg-sky-500/15 p-2 text-sky-400">
                <CheckCircle2 className="h-4 w-4" />
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-sky-300">
                {formatUsd(kpis.verifiedRecoveredCents)}
              </span>
              <span className="text-xs text-sky-400/80">
                ({kpis.verifiedRecoveredCount} won)
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              Reconciled against subsequent DoorDash payout credit rows
            </p>
          </div>
        </section>

        {/* Collapsible Drag-and-Drop Historical Audit Uploader & Inbound Webhook Simulator */}
        {showUploadPanel && (
          <section className="rounded-xl border border-emerald-500/30 bg-slate-900/90 p-5 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Upload className="h-4 w-4 text-emerald-400" />
                  14-Day Historical Audit Uploader &amp; Tier 1 Nightly Email Webhook Simulator
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Drop a plain-text POS Electronic Journal (<code>.txt</code> / <code>.log</code>) or
                  DoorDash Financial Payout (<code>.csv</code>), or trigger a live webhook test to{' '}
                  <code>/api/webhooks/inbound-email</code>.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSimulateInboundEmailWebhook}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-50"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Simulate Nightly Email Webhook Drop ($46.00 Claim)
                </button>
                <button
                  onClick={() => setShowUploadPanel(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* Left column: Store selector + Drag & drop zone */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Target Store Location
                  </label>
                  <select
                    value={uploadStoreId}
                    onChange={(e) => setUploadStoreId(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                  >
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.pos_store_code} — {s.name} ({s.iana_timezone})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Payload Format &amp; Preset Templates
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setUploadFileType('POS_EJ');
                        setUploadFilename('CHI-104_pos_ej_drop.log');
                        setUploadContent(SAMPLE_POS_EJ_DROP);
                      }}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
                        uploadFileType === 'POS_EJ'
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400'
                      }`}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      POS EJ (.log)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUploadFileType('DOORDASH_CSV');
                        setUploadFilename('DoorDash_Payout_Batch.csv');
                        setUploadContent(SAMPLE_DD_CSV_DROP);
                      }}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
                        uploadFileType === 'DOORDASH_CSV'
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400'
                      }`}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      DoorDash (.csv)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUploadFileType('UBEREATS_CSV');
                        setUploadFilename('UberEats_Payout_Batch.csv');
                        setUploadContent(
                          `order_id,order_date,food_sales,inaccurate_order_adjustment,issue_type,items,eater_comment\nUE-9918A2,2026-11-22 19:15:00,$46.00,-$22.00,Missing Item,"2x Wings 10pc, 2x Ranch",Missing wings`
                        );
                      }}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
                        uploadFileType === 'UBEREATS_CSV'
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400'
                      }`}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      UberEats (.csv)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUploadFileType('GRUBHUB_CSV');
                        setUploadFilename('Grubhub_Adjustments.csv');
                        setUploadContent(
                          `order_number,transaction_date,subtotal,adjustment_amount,adjustment_reason,items,diner_note\nGH-442019,2026-11-22 19:20:00,$40.00,-$18.50,Missing Item,"2x Wings 10pc, 1x Mozzarella Sticks",Diner reported missing sticks`
                        );
                      }}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
                        uploadFileType === 'GRUBHUB_CSV'
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-400'
                      }`}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      Grubhub (.csv)
                    </button>
                  </div>
                </div>

                {/* Drag and Drop File Input */}
                <label
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file) handleFileDropOrSelect(file);
                  }}
                  className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 bg-slate-950/60 p-5 text-center hover:border-emerald-500/60 transition"
                >
                  <Upload className="h-6 w-6 text-emerald-400 mb-1.5" />
                  <span className="text-xs font-medium text-slate-200">
                    Drag &amp; drop <code>.txt</code>, <code>.log</code>, or <code>.csv</code> file
                  </span>
                  <span className="text-[11px] text-slate-400 mt-0.5">
                    or click to browse local filesystem
                  </span>
                  <input
                    type="file"
                    accept=".txt,.log,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFileDropOrSelect(f);
                    }}
                  />
                </label>
              </div>

              {/* Right 2 columns: Editable Raw Payload Inspector & Run Button */}
              <div className="lg:col-span-2 flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-slate-300">
                    Raw Source Payload Preview (<code>{uploadFilename}</code>)
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Preserved verbatim in <code>raw_ej_block</code> / <code>raw_csv_row</code>
                  </span>
                </div>
                <textarea
                  rows={8}
                  value={uploadContent}
                  onChange={(e) => setUploadContent(e.target.value)}
                  className="w-full flex-1 rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-emerald-300 focus:border-emerald-500 focus:outline-none"
                />
                <div className="mt-3 flex items-center justify-end gap-3">
                  <button
                    onClick={handleRunManualUpload}
                    disabled={uploading}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${uploading ? 'animate-spin' : ''}`} />
                    {uploading
                      ? 'Ingesting & Running 3-Pass Reconciliation...'
                      : 'Ingest Payload & Run 3-Pass Reconciliation'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Dispute Queue Filter Bar & Table */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/70 shadow-lg overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                Dispute Reconciliation Queue
                <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300">
                  {filteredClaims.length} Claims
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Click any row to open the Side-by-Side POS Electronic Journal Comparison Drawer &amp;
                1-Click Dispute Packet
              </p>
            </div>

            {/* Lifecycle Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-slate-400 mr-1" />
              {[
                { key: 'ALL', label: 'All Claims' },
                { key: 'AUTO_QUEUE', label: 'Auto-Queued (≥80)' },
                { key: 'EXPIRING_72H', label: 'Expiring <72h' },
                { key: 'MANUAL_REVIEW', label: 'Manual Review' },
                { key: 'SUBMITTED', label: 'Submitted' },
                { key: 'WON', label: 'Won / Recovered' },
                { key: 'IGNORED', label: 'Ignored (Anti-Ban)' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setStatusFilter(tab.key)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                    statusFilter === tab.key
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-slate-950/60 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Claims Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800/80 bg-slate-950/50 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="py-3 pl-5 pr-3">DoorDash Order &amp; Store</th>
                  <th className="px-3 py-3">Deduction Category</th>
                  <th className="px-3 py-3">Amount</th>
                  <th className="px-3 py-3">Reconciliation Pass (1:1 Lock)</th>
                  <th className="px-3 py-3">Win Score</th>
                  <th className="px-3 py-3">14-Day Window</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="py-3 pl-3 pr-5 text-right">Quick Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      Loading reconciled claims...
                    </td>
                  </tr>
                ) : filteredClaims.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      No claims match the active filter.
                    </td>
                  </tr>
                ) : (
                  filteredClaims.map((claim) => {
                    const hoursLeft = getHoursRemaining(claim.dispute_deadline_at);
                    const isUrgent =
                      (claim.status === 'AUTO_QUEUE' || claim.status === 'MANUAL_REVIEW') &&
                      hoursLeft > 0 &&
                      hoursLeft <= 72;

                    return (
                      <tr
                        key={claim.id}
                        onClick={() => setActiveClaim(claim)}
                        className="cursor-pointer hover:bg-slate-800/40 transition group"
                      >
                        <td className="py-3.5 pl-5 pr-3">
                          <div className="font-mono font-semibold text-white group-hover:text-emerald-300 flex items-center gap-1.5">
                            {claim.external_order_id}
                            <ArrowUpRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition text-emerald-400" />
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {claim.pos_store_code} • {claim.evidence_packet_json.order_created_local}
                          </div>
                        </td>

                        <td className="px-3 py-3.5">
                          <DeductionBadge type={claim.deduction_type} />
                          {claim.items_summary && (
                            <div className="mt-1 max-w-[210px] truncate text-[11px] text-slate-400">
                              {claim.items_summary}
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-3.5 font-mono font-semibold text-white">
                          {formatUsd(claim.deduction_cents)}
                          {claim.status === 'WON' && (
                            <div className="text-[10px] font-sans font-normal text-emerald-400">
                              +{formatUsd(claim.verified_recovered_cents)} credited
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-3.5">
                          <MatchPassBadge
                            pass={claim.match_pass}
                            confidence={claim.match_confidence}
                            posCheckNumber={claim.pos_check_number}
                          />
                        </td>

                        <td className="px-3 py-3.5">
                          <ScorePill score={claim.dispute_score} />
                        </td>

                        <td className="px-3 py-3.5">
                          {claim.status === 'WON' || claim.status === 'SUBMITTED' ? (
                            <span className="text-slate-400">Filed in window</span>
                          ) : hoursLeft <= 0 ? (
                            <span className="text-rose-400 font-medium">Expired</span>
                          ) : (
                            <span
                              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${
                                isUrgent
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                  : 'text-slate-300'
                              }`}
                            >
                              {isUrgent && <AlertTriangle className="h-3 w-3 text-rose-400" />}
                              {hoursLeft < 72
                                ? `${hoursLeft}h left`
                                : `${Math.ceil(hoursLeft / 24)}d left`}
                            </span>
                          )}
                        </td>

                        <td className="px-3 py-3.5">
                          <StatusBadge status={claim.status} />
                        </td>

                        <td
                          className="py-3.5 pl-3 pr-5 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center gap-2">
                            <button
                              onClick={() => handleCopyDisputePacket(claim)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition"
                              title="1-Click Copy Policy-Cited Evidence Packet"
                            >
                              {copiedId === claim.id ? (
                                <>
                                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy Packet
                                </>
                              )}
                            </button>
                            <button
                              onClick={() => setActiveClaim(claim)}
                              className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition"
                            >
                              Inspect
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Phase 2 Automation & Billing Panel */}
        <Phase2AutomationPanel
          selectedStoreId={selectedStoreId}
          stores={stores}
          autoQueuedCount={kpis.autoQueuedCount}
          onDataChanged={() => fetchDashboardData(selectedStoreId)}
          onNotify={showToast}
        />

        {/* Bottom Ingestion Logs Monitor (`ingestion_logs`) */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-white">
                Automated Nightly Ingestion &amp; Audit Log Monitor (<code>ingestion_logs</code>)
              </h3>
            </div>
            <span className="text-xs text-slate-400">
              Tracks Tier 1 Inbound Email Webhooks &amp; Manual Historical Uploads
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] uppercase text-slate-400">
                  <th className="py-2 pr-3">Timestamp (UTC)</th>
                  <th className="px-3 py-2">Source Channel</th>
                  <th className="px-3 py-2">Store / Routing Address</th>
                  <th className="px-3 py-2">File Type &amp; Name</th>
                  <th className="px-3 py-2">Records Parsed</th>
                  <th className="px-3 py-2">Voids / $0 Skipped</th>
                  <th className="px-3 py-2">Claims Reconciled</th>
                  <th className="pl-3 py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {ingestionLogs.map((log) => (
                  <tr key={log.id} className="text-slate-300">
                    <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-400">
                      {new Date(log.created_at).toISOString().replace('T', ' ').slice(0, 19)}Z
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                          log.source_type === 'EMAIL_WEBHOOK'
                            ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                            : log.source_type === 'MANUAL_UPLOAD'
                              ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                              : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {log.source_type === 'EMAIL_WEBHOOK' && <Mail className="h-3 w-3" />}
                        {log.source_type}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-200">{log.store_name}</div>
                      {log.recipient_email && (
                        <div className="font-mono text-[10px] text-slate-400">
                          {log.recipient_email}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-200">
                      <span className="mr-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        {log.file_type}
                      </span>
                      {log.filename}
                    </td>
                    <td className="px-3 py-2.5 font-mono">{log.records_parsed}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-400">{log.records_skipped}</td>
                    <td className="px-3 py-2.5 font-mono text-emerald-400 font-semibold">
                      {log.claims_reconciled}
                    </td>
                    <td className="pl-3 py-2.5 text-right">
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Slide-Over Side-by-Side Comparison Drawer */}
      {activeClaim && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm">
          <div className="relative flex h-full w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-900/80">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-base font-bold text-white">
                    Order {activeClaim.external_order_id}
                  </span>
                  <DeductionBadge type={activeClaim.deduction_type} />
                  <StatusBadge status={activeClaim.status} />
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {activeClaim.store_name} ({activeClaim.pos_store_code}) • Timezone:{' '}
                  <code>{activeClaim.iana_timezone}</code> • Store Menu Markup:{' '}
                  <strong>{Math.round(activeClaim.menu_markup_pct * 100)}%</strong>
                </p>
              </div>
              <button
                onClick={() => setActiveClaim(null)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Top Action & Lifecycle Control Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/15 p-4">
                <div>
                  <div className="text-xs font-semibold text-emerald-300">
                    1-Click Portal Submission Packet Ready
                  </div>
                  <div className="text-[11px] text-slate-300 mt-0.5">
                    Includes policy citation, markup-adjusted subtotal reconciliation, KDS timestamps,
                    and verbatim POS EJ receipt log.
                  </div>
                </div>
                <button
                  onClick={() => handleCopyDisputePacket(activeClaim)}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg hover:bg-emerald-500 transition"
                >
                  {copiedId === activeClaim.id ? (
                    <>
                      <Check className="h-4 w-4" />
                      Copied to Clipboard!
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      1-Click Copy Dispute Packet
                    </>
                  )}
                </button>
              </div>

              {/* Side-by-Side Comparison Grid: DoorDash Payout Row vs. POS Electronic Journal */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Left Card: DoorDash Financial Deduction Metadata */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-rose-300">
                      DoorDash Payout Deduction
                    </span>
                    <span className="font-mono text-sm font-bold text-rose-400">
                      -{formatUsd(activeClaim.deduction_cents)}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Order ID:</span>
                      <span className="font-mono text-slate-200">
                        {activeClaim.external_order_id}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Created (Local):</span>
                      <span className="font-mono text-slate-200">
                        {activeClaim.evidence_packet_json.order_created_local}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Created (UTC):</span>
                      <span className="font-mono text-[11px] text-slate-400">
                        {activeClaim.order_created_at}
                      </span>
                    </div>
                    {activeClaim.evidence_packet_json.driver_arrived_local && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Dasher Arrived:</span>
                        <span className="font-mono text-amber-300">
                          {activeClaim.evidence_packet_json.driver_arrived_local}
                        </span>
                      </div>
                    )}
                    {activeClaim.evidence_packet_json.cancelled_local && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Cancelled At:</span>
                        <span className="font-mono text-rose-300">
                          {activeClaim.evidence_packet_json.cancelled_local}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-400">DoorDash Subtotal:</span>
                      <span className="font-mono text-slate-200">
                        {formatUsd(activeClaim.dd_subtotal_cents)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">
                        Expected POS ({Math.round(activeClaim.menu_markup_pct * 100)}% markup):
                      </span>
                      <span className="font-mono text-emerald-300 font-semibold">
                        {formatUsd(activeClaim.evidence_packet_json.expected_pos_subtotal_cents)}
                      </span>
                    </div>
                    {activeClaim.customer_note && (
                      <div className="pt-1 border-t border-slate-800/80">
                        <span className="text-slate-400 block">Platform Note:</span>
                        <span className="text-slate-300 italic">
                          &ldquo;{activeClaim.customer_note}&rdquo;
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Card: Reconciled POS Check & KDS Telemetry */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                      POS Electronic Journal &amp; KDS Proof
                    </span>
                    <MatchPassBadge
                      pass={activeClaim.match_pass}
                      confidence={activeClaim.match_confidence}
                      posCheckNumber={activeClaim.pos_check_number}
                    />
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">POS Check Number:</span>
                      <span className="font-mono font-semibold text-white">
                        {activeClaim.pos_check_number
                          ? `CHK #${activeClaim.pos_check_number}`
                          : activeClaim.match_pass === 'STORE_ACTIVITY_PROOF'
                            ? `${activeClaim.evidence_packet_json.adjacent_active_checks.length} Active Checks (±10m)`
                            : 'Unmatched'}
                      </span>
                    </div>
                    {activeClaim.evidence_packet_json.pos_opened_local && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">POS Check Opened:</span>
                        <span className="font-mono text-slate-200">
                          {activeClaim.evidence_packet_json.pos_opened_local}
                        </span>
                      </div>
                    )}
                    {activeClaim.evidence_packet_json.kds_bumped_local && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">KDS Kitchen Bump:</span>
                        <span className="font-mono font-semibold text-emerald-300">
                          {activeClaim.evidence_packet_json.kds_bumped_local}
                        </span>
                      </div>
                    )}
                    {activeClaim.pos_subtotal_cents !== null && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Actual POS Subtotal:</span>
                        <span className="font-mono font-semibold text-emerald-300">
                          {formatUsd(activeClaim.pos_subtotal_cents)}
                        </span>
                      </div>
                    )}
                    {activeClaim.evidence_packet_json.jaccard_similarity !== null && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Item Fingerprint Jaccard:</span>
                        <span className="font-mono text-sky-300">
                          {Math.round(activeClaim.evidence_packet_json.jaccard_similarity * 100)}%
                          similarity
                        </span>
                      </div>
                    )}
                    <div className="pt-1 border-t border-slate-800/80">
                      <span className="text-slate-400 block mb-1">
                        Anti-Ban Confidence Gate Breakdown:
                      </span>
                      {activeClaim.score_breakdown.map((b, i) => (
                        <div
                          key={i}
                          className="rounded bg-slate-950/90 p-2 text-[11px] text-slate-300 border border-slate-800"
                        >
                          <div className="font-mono font-semibold text-emerald-400">
                            {b.rule} ({b.points}/100)
                          </div>
                          <div className="mt-0.5 text-slate-400">{b.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Policy-Cited Rebuttal & Verbatim POS Electronic Journal Block */}
              <div className="space-y-3">
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                    Compiled Policy-Cited Rebuttal Statement
                  </div>
                  <p className="text-xs leading-relaxed text-slate-200">
                    {activeClaim.evidence_packet_json.rebuttal_statement}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      Verbatim POS Electronic Journal (<code>raw_ej_block</code>)
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Immutable Source Payload Proof
                    </span>
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-slate-900/90 p-3.5 font-mono text-xs leading-relaxed text-emerald-300 border border-slate-800">
                    {activeClaim.evidence_packet_json.raw_ej_block ??
                      '[No matched POS Electronic Journal check block attached]'}
                  </pre>
                </div>
              </div>

              {/* Lifecycle State Transitions */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="text-xs font-semibold text-slate-300 mb-2.5">
                  Update Dispute Lifecycle State (Recovery Verification Tracking)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(
                    [
                      'AUTO_QUEUE',
                      'MANUAL_REVIEW',
                      'SUBMITTED',
                      'WON',
                      'LOST',
                      'IGNORED',
                    ] as ClaimStatus[]
                  ).map((st) => (
                    <button
                      key={st}
                      onClick={() => handleUpdateClaimStatus(activeClaim.id, st)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        activeClaim.status === st
                          ? 'bg-emerald-600 text-white'
                          : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      Mark {st}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Store Configuration Modal */}
      {showStoreModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  Multi-Store Franchise Registry &amp; Tier 1 Inbound Routing
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Configure store IANA timezones (DST-aware), DoorDash markup %, and POS store codes
                </p>
              </div>
              <button
                onClick={() => setShowStoreModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Existing Stores List */}
            <div className="mt-4 max-h-48 overflow-y-auto divide-y divide-slate-800/70 rounded-xl border border-slate-800 bg-slate-900/50">
              {stores.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                >
                  <div>
                    <span className="font-semibold text-white">{s.pos_store_code}</span> —{' '}
                    <span className="text-slate-300">{s.name}</span>
                    <div className="font-mono text-[11px] text-emerald-400">
                      {s.inbound_email_address}
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-slate-400">
                    <div>
                      TZ: <strong className="text-slate-200">{s.iana_timezone}</strong>
                    </div>
                    <div>
                      Markup:{' '}
                      <strong className="text-slate-200">
                        {Math.round(s.menu_markup_pct * 100)}%
                      </strong>{' '}
                      • DD: {s.dd_merchant_store_id}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Add / Update Store Form */}
            <form onSubmit={handleSaveNewStore} className="mt-5 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Add or Update Store Location
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Store Name</label>
                  <input
                    required
                    value={newStoreName}
                    onChange={(e) => setNewStoreName(e.target.value)}
                    placeholder="e.g. Windy City Wings #109 (Wicker Park)"
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    POS Store Code (Generates Inbound Email)
                  </label>
                  <input
                    required
                    value={newStoreCode}
                    onChange={(e) => setNewStoreCode(e.target.value)}
                    placeholder="e.g. CHI-109"
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    DoorDash Merchant Store ID (Optional)
                  </label>
                  <input
                    value={newStoreDdId}
                    onChange={(e) => setNewStoreDdId(e.target.value)}
                    placeholder="Optional (defaults to N/A)"
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">IANA Timezone</label>
                    <select
                      value={newStoreTz}
                      onChange={(e) => setNewStoreTz(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2 text-xs text-white"
                    >
                      <option value="America/New_York">America/New_York</option>
                      <option value="America/Chicago">America/Chicago</option>
                      <option value="America/Denver">America/Denver</option>
                      <option value="America/Los_Angeles">America/Los_Angeles</option>
                      <option value="America/Phoenix">America/Phoenix</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Menu Markup (%)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={newStoreMarkup}
                      onChange={(e) => setNewStoreMarkup(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white"
                    />
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowStoreModal(false)}
                  className="rounded-lg border border-slate-800 px-4 py-2 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  Save Store Location
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function DeductionBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    CANCELLED_AFTER_PREP: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    PREP_TIME_PENALTY: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    FALSE_STORE_CLOSED: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    MISSING_ITEM: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    QUALITY_SUBJECTIVE: 'bg-slate-800 text-slate-400 border-slate-700',
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold ${
        styles[type] ?? 'bg-slate-800 text-slate-300 border-slate-700'
      }`}
    >
      {type.replace(/_/g, ' ')}
    </span>
  );
}

function MatchPassBadge({
  pass,
  confidence,
  posCheckNumber,
}: {
  pass: string;
  confidence: number;
  posCheckNumber: string | null;
}) {
  const labelMap: Record<string, string> = {
    PASS_1_EXACT_REF: 'Pass 1: Exact Ref',
    PASS_2_SUBTOTAL_WINDOW: 'Pass 2: Markup Subtotal',
    PASS_3_ITEM_JACCARD: 'Pass 3: Item Jaccard',
    STORE_ACTIVITY_PROOF: 'POS Activity (±10m)',
    UNMATCHED: 'Unmatched',
  };

  return (
    <div>
      <span
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
          pass === 'UNMATCHED'
            ? 'bg-slate-800 text-slate-400'
            : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        }`}
      >
        {labelMap[pass] ?? pass} ({confidence}%)
      </span>
      {posCheckNumber && (
        <div className="text-[11px] font-mono text-slate-400 mt-0.5">
          Locked to POS CHK #{posCheckNumber}
        </div>
      )}
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  const isHigh = score >= 80;
  const isMid = score >= 50 && score < 80;
  return (
    <div className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${
          isHigh
            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
            : isMid
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              : 'bg-slate-800 text-slate-400 border border-slate-700'
        }`}
      >
        {isHigh ? (
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
        )}
        {score}/100
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: ClaimStatus }) {
  const map: Record<ClaimStatus, string> = {
    AUTO_QUEUE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    MANUAL_REVIEW: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    IGNORED: 'bg-slate-800 text-slate-400 border-slate-700',
    SUBMITTED: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
    WON: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
    LOST: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${map[status]}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
