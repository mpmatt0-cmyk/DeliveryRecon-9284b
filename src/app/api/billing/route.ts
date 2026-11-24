import { NextRequest, NextResponse } from 'next/server';
import {
  generateRecoveryInvoiceForStore,
  listRecoveryInvoices,
} from '@/lib/billing/stripe-recovery';

export async function GET(req: NextRequest) {
  try {
    const storeId = req.nextUrl.searchParams.get('storeId') ?? 'ALL';
    const invoices = await listRecoveryInvoices(storeId);
    return NextResponse.json({ invoices });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list recovery invoices' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { storeId, feePct, periodLabel, stripeCustomerId } = body as {
      storeId: string;
      feePct?: number;
      periodLabel?: string;
      stripeCustomerId?: string;
    };

    if (!storeId) {
      return NextResponse.json({ error: 'storeId is required' }, { status: 400 });
    }

    const invoice = await generateRecoveryInvoiceForStore({
      storeId,
      feePct,
      periodLabel,
      stripeCustomerId,
    });

    return NextResponse.json({ invoice });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate recovery invoice' },
      { status: 400 }
    );
  }
}
