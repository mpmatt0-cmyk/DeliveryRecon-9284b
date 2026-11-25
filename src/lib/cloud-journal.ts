import { getStore } from '@netlify/blobs';

export interface PersistedCustomStore {
  id: string;
  name: string;
  pos_store_code: string;
  dd_merchant_store_id: string;
  iana_timezone: string;
  menu_markup_pct: number;
}

export interface PersistedUploadBatch {
  id: string;
  store_pos_code: string;
  fileType: 'POS_EJ' | 'DOORDASH_CSV' | 'UBEREATS_CSV' | 'GRUBHUB_CSV';
  filename: string;
  content: string;
  sourceType: 'EMAIL_WEBHOOK' | 'MANUAL_UPLOAD';
  createdAt: string;
}

export interface CloudJournalState {
  stores: PersistedCustomStore[];
  uploads: PersistedUploadBatch[];
}

const STORE_NAME = 'claimpilot-state-v1';
const STATE_KEY = 'journal';

function canUseNetlifyBlobs(): boolean {
  if (process.env.VITEST) return false;
  return Boolean(process.env.NETLIFY_BLOBS_CONTEXT);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

export async function readCloudJournal(): Promise<CloudJournalState | null> {
  if (!canUseNetlifyBlobs()) return null;
  return withTimeout(
    (async () => {
      const blobStore = getStore({ name: STORE_NAME, consistency: 'strong' });
      const data = (await blobStore.get(STATE_KEY, {
        type: 'json',
        consistency: 'strong',
      })) as CloudJournalState | null;
      if (!data) return { stores: [], uploads: [] };
      return {
        stores: Array.isArray(data.stores) ? data.stores : [],
        uploads: Array.isArray(data.uploads) ? data.uploads : [],
      };
    })(),
    1200,
    null
  );
}

export async function recordStoreInCloudJournal(
  store: PersistedCustomStore
): Promise<void> {
  if (!canUseNetlifyBlobs()) return;
  await withTimeout(
    (async () => {
      const current = (await readCloudJournal()) ?? { stores: [], uploads: [] };
      const code = store.pos_store_code.toUpperCase();
      const filtered = current.stores.filter(
        (s) => s.pos_store_code.toUpperCase() !== code
      );
      filtered.push({ ...store, pos_store_code: code });

      const blobStore = getStore({ name: STORE_NAME, consistency: 'strong' });
      await blobStore.setJSON(STATE_KEY, {
        stores: filtered,
        uploads: current.uploads,
      });
    })(),
    1200,
    undefined
  );
}

export async function recordUploadInCloudJournal(
  batch: PersistedUploadBatch
): Promise<void> {
  if (!canUseNetlifyBlobs()) return;
  await withTimeout(
    (async () => {
      const current = (await readCloudJournal()) ?? { stores: [], uploads: [] };
      if (current.uploads.some((u) => u.id === batch.id)) return;
      const nextUploads = [...current.uploads, batch].slice(-30);

      const blobStore = getStore({ name: STORE_NAME, consistency: 'strong' });
      await blobStore.setJSON(STATE_KEY, {
        stores: current.stores,
        uploads: nextUploads,
      });
    })(),
    1200,
    undefined
  );
}
