import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { store2faEmailCode } from '@/lib/automation/two-factor-router';

/**
 * Phase 2 Role-Based 2FA Email Routing Webhook: POST /api/webhooks/dispute-2fa
 *
 * Receives forwarded 2FA/OTP verification emails sent to `disputes+{client}@claimpilot.app`
 * so Playwright session-authenticated portal workers can complete merchant portal logins
 * without manual operator intervention.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const toEmail: string = body.to || body.recipient || '';
    const fromEmail: string = body.from || body.sender || 'no-reply@doordash.com';
    const subject: string = body.subject || 'Merchant Portal Verification Code';
    const text: string = body.text || body.body || body.content || '';

    if (!toEmail || !text) {
      return NextResponse.json(
        {
          error:
            '2FA webhook requires "to" (e.g. disputes+windy-city@claimpilot.app) and "text" email body.',
        },
        { status: 400 }
      );
    }

    const stored = await store2faEmailCode({
      recipientEmail: toEmail,
      senderEmail: fromEmail,
      subject,
      bodyText: text,
    });

    if (!stored) {
      return NextResponse.json(
        { error: 'No valid 4-8 digit 2FA OTP code detected in email payload.' },
        { status: 422 }
      );
    }

    return NextResponse.json({
      status: 'CAPTURED',
      ...stored,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process 2FA email' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const db = await getDb();
    const res = await db.query(
      `SELECT * FROM dispute_2fa_codes ORDER BY created_at DESC LIMIT 15`
    );
    return NextResponse.json({ codes: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list 2FA codes' },
      { status: 500 }
    );
  }
}
