import { NextRequest, NextResponse } from 'next/server';
import { listClaims } from '@/lib/repository';
import {
  listSubmissionJobs,
  submitClaimViaPortalWorker,
} from '@/lib/automation/portal-submitter';

export async function GET(req: NextRequest) {
  try {
    const storeId = req.nextUrl.searchParams.get('storeId') ?? 'ALL';
    const jobs = await listSubmissionJobs(storeId);
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list submission jobs' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { claimId, storeId, batchAutoQueue, require2fa } = body as {
      claimId?: string;
      storeId?: string;
      batchAutoQueue?: boolean;
      require2fa?: boolean;
    };

    const allClaims = await listClaims(storeId ?? 'ALL');

    if (batchAutoQueue) {
      const autoQueued = allClaims.filter((c) => c.status === 'AUTO_QUEUE');
      const jobs = [];
      for (const claim of autoQueued) {
        jobs.push(await submitClaimViaPortalWorker(claim, { require2fa }));
      }
      return NextResponse.json({ submittedCount: jobs.length, jobs });
    }

    if (!claimId) {
      return NextResponse.json(
        { error: 'claimId or batchAutoQueue=true is required' },
        { status: 400 }
      );
    }

    const target = allClaims.find((c) => c.id === claimId);
    if (!target) {
      return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
    }

    const job = await submitClaimViaPortalWorker(target, { require2fa });
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Portal submission failed' },
      { status: 500 }
    );
  }
}
