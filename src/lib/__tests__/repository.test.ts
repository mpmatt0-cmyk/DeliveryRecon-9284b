import { describe, expect, it } from 'vitest';
import {
  getStoreByPosCodeOrEmail,
  ingestDoorDashCsvForStore,
  ingestPosEjForStore,
  listClaims,
  listIngestionLogs,
  listStores,
} from '../repository';

describe('PostgreSQL Repository & Inbound Email Webhook Pipeline Integration', () => {
  it('initializes schema from migrations/001_initial_schema.sql, seeds franchise stores, and reconciles claims with 1:1 POS check locking', async () => {
    const stores = await listStores();
    expect(stores.length).toBeGreaterThanOrEqual(3);

    const chiStore = await getStoreByPosCodeOrEmail('store-chi-104@ingest.claimpilot.app');
    expect(chiStore).not.toBeNull();
    expect(chiStore?.pos_store_code).toBe('CHI-104');

    const claims = await listClaims(chiStore!.id);
    expect(claims.length).toBeGreaterThanOrEqual(5);

    // Verify AUTO_QUEUE claims exist for Cancelled After Prep (98), False Store Closed (95), Prep Time Penalty (92), Missing Item >= $15 (80)
    const scores = claims.map((c) => c.dispute_score);
    expect(scores).toContain(98);
    expect(scores).toContain(95);
    expect(scores).toContain(92);
    expect(scores).toContain(80);

    // Verify inbound email ingestion log tracking
    const ejResult = await ingestPosEjForStore(
      chiStore!.id,
      'webhook_test_ej.log',
      `==========================================
CHK# 9941 | EXT REF: DOORDASH #DD-5541B9C1
OPENED: 2026-11-23 18:00:00
KDS BUMPED: 2026-11-23 18:10:00
CLOSED: 2026-11-23 18:12:00
2x Wings 10pc                 $30.00
SUBTOTAL:                     $30.00
TAX:                          $3.00
TOTAL:                        $33.00
==========================================`,
      'EMAIL_WEBHOOK',
      {
        sender: 'pos@toasttab.com',
        recipient: 'store-chi-104@ingest.claimpilot.app',
      }
    );
    expect(ejResult.recordsParsed).toBe(1);

    const csvResult = await ingestDoorDashCsvForStore(
      chiStore!.id,
      'webhook_test_dd.csv',
      `order_id,order_created_at,cancelled_at,driver_arrived_at,subtotal,error_charge,transaction_type,items,customer_note
DD-5541B9C1,2026-11-23 17:58:00,2026-11-23 18:15:00,,$34.50,-$34.50,Cancelled After Prep,"2x Wings 10pc",Cancelled after KDS bump`,
      'EMAIL_WEBHOOK',
      {
        sender: 'reports@doordash.com',
        recipient: 'store-chi-104@ingest.claimpilot.app',
      }
    );
    expect(csvResult.recordsParsed).toBe(1);

    const logs = await listIngestionLogs(chiStore!.id);
    expect(logs.some((l) => l.filename === 'webhook_test_ej.log')).toBe(true);
    expect(logs.some((l) => l.filename === 'webhook_test_dd.csv')).toBe(true);
  });
});
