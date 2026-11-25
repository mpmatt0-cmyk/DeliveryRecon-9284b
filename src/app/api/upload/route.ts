import { NextRequest, NextResponse } from 'next/server';
import {
  createOrUpdateStore,
  getStoreById,
  ingestPlatformCsvForStore,
  ingestPosEjForStore,
} from '@/lib/repository';
import { StoreConfig } from '@/lib/types';

type UploadFileType = 'POS_EJ' | 'DOORDASH_CSV' | 'UBEREATS_CSV' | 'GRUBHUB_CSV';

function detectUploadType(filename: string, content: string): UploadFileType {
  const lowerName = (filename || '').toLowerCase();
  const headerLine = content.trimStart().split(/\r?\n/)[0]?.toLowerCase() ?? '';

  if (
    lowerName.includes('ubereats') ||
    lowerName.includes('uber_eats') ||
    headerLine.includes('inaccurate_order_adjustment') ||
    headerLine.includes('workflow_id') ||
    headerLine.includes('ubereats_order_id')
  ) {
    return 'UBEREATS_CSV';
  }

  if (
    lowerName.includes('grubhub') ||
    headerLine.includes('grubhub_order_id') ||
    (headerLine.includes('order_number') && headerLine.includes('adjustment_amount'))
  ) {
    return 'GRUBHUB_CSV';
  }

  if (lowerName.endsWith('.csv') || headerLine.includes('order_id,')) {
    return 'DOORDASH_CSV';
  }

  return 'POS_EJ';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { storeId, storeConfig, fileType, filename, content } = body as {
      storeId: string;
      storeConfig?: StoreConfig;
      fileType?: UploadFileType;
      filename: string;
      content: string;
    };

    if (!storeId || !content) {
      return NextResponse.json(
        { error: 'storeId and file content are required' },
        { status: 400 }
      );
    }

    let resolvedStoreId = storeId;
    const existingStore = await getStoreById(storeId);
    if (!existingStore && storeConfig) {
      const recreated = await createOrUpdateStore({
        id: storeConfig.id,
        name: storeConfig.name,
        pos_store_code: storeConfig.pos_store_code,
        dd_merchant_store_id: storeConfig.dd_merchant_store_id || 'N/A',
        iana_timezone: storeConfig.iana_timezone,
        menu_markup_pct: storeConfig.menu_markup_pct,
      });
      resolvedStoreId = recreated.id;
    }

    const detectedType: UploadFileType =
      fileType ?? detectUploadType(filename || '', content);

    if (detectedType === 'POS_EJ') {
      const result = await ingestPosEjForStore(
        resolvedStoreId,
        filename || 'manual_pos_ej.log',
        content,
        'MANUAL_UPLOAD'
      );
      return NextResponse.json({
        fileType: 'POS_EJ',
        ...result,
      });
    } else {
      const platform =
        detectedType === 'UBEREATS_CSV'
          ? 'UBEREATS'
          : detectedType === 'GRUBHUB_CSV'
            ? 'GRUBHUB'
            : 'DOORDASH';

      const result = await ingestPlatformCsvForStore(
        resolvedStoreId,
        platform,
        filename || `manual_${platform.toLowerCase()}_payout.csv`,
        content,
        'MANUAL_UPLOAD'
      );
      return NextResponse.json({
        fileType: detectedType,
        platform,
        ...result,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process uploaded file' },
      { status: 500 }
    );
  }
}
