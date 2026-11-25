import { NextRequest, NextResponse } from 'next/server';
import { createOrUpdateStore, listStores } from '@/lib/repository';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stores = await listStores();
    return NextResponse.json({ stores });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list stores' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, pos_store_code, dd_merchant_store_id, iana_timezone, menu_markup_pct } = body;

    if (!name || !pos_store_code || !iana_timezone) {
      return NextResponse.json(
        { error: 'Missing required store fields (name, pos_store_code, iana_timezone)' },
        { status: 400 }
      );
    }

    const store = await createOrUpdateStore({
      name,
      pos_store_code,
      dd_merchant_store_id: dd_merchant_store_id?.trim() || 'N/A',
      iana_timezone,
      menu_markup_pct: Number(menu_markup_pct ?? 0.15),
    });

    return NextResponse.json({ store });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save store' },
      { status: 500 }
    );
  }
}
