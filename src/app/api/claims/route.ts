import { NextRequest, NextResponse } from 'next/server';
import {
  listClaims,
  listIngestionLogs,
  listStores,
  updateClaimLifecycleStatus,
} from '@/lib/repository';
import { ClaimStatus } from '@/lib/types';

export async function GET(req: NextRequest) {
  try {
    const storeId = req.nextUrl.searchParams.get('storeId') ?? 'ALL';
    const [stores, claims, ingestionLogs] = await Promise.all([
      listStores(),
      listClaims(storeId),
      listIngestionLogs(storeId),
    ]);

    return NextResponse.json({
      stores,
      claims,
      ingestionLogs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load claims data' },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { claimId, status } = body as { claimId: string; status: ClaimStatus };

    if (!claimId || !status) {
      return NextResponse.json({ error: 'claimId and status are required' }, { status: 400 });
    }

    await updateClaimLifecycleStatus(claimId, status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update claim status' },
      { status: 500 }
    );
  }
}
