import { NextRequest, NextResponse } from 'next/server';
import {
  getStoreByPosCodeOrEmail,
  ingestDoorDashCsvForStore,
  ingestPosEjForStore,
} from '@/lib/repository';

/**
 * Tier 1 Inbound Email Webhook: POST /api/webhooks/inbound-email
 *
 * Accepts automated nightly POS Electronic Journal (.txt/.log) or CSV drops sent to
 * `store-{pos_store_code}@ingest.claimpilot.app` (SendGrid / Postmark / Mailgun / JSON webhook payload).
 * Resolves the target store by recipient email (`to`) or `pos_store_code`, parses all attachments or body text,
 * writes an audit entry to `ingestion_logs`, and runs the 3-Pass Reconciliation Engine.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const toEmail: string = body.to || body.recipient || '';
    const fromEmail: string = body.from || body.sender || 'pos-export@restaurant-pos.local';
    const filename: string = body.filename || 'nightly_ej_drop.log';
    const rawContent: string = body.content || body.attachment_text || body.text || '';

    if (!toEmail || !rawContent) {
      return NextResponse.json(
        {
          error:
            'Inbound email webhook requires "to" (e.g. store-chi-104@ingest.claimpilot.app) and "content" payload.',
        },
        { status: 400 }
      );
    }

    const store = await getStoreByPosCodeOrEmail(toEmail);
    if (!store) {
      return NextResponse.json(
        {
          error: `No registered store matched inbound routing address "${toEmail}". Expected format: store-{pos_store_code}@ingest.claimpilot.app`,
        },
        { status: 404 }
      );
    }

    const isCsv =
      filename.toLowerCase().endsWith('.csv') ||
      rawContent.trimStart().startsWith('order_id,');

    if (isCsv) {
      const result = await ingestDoorDashCsvForStore(
        store.id,
        filename,
        rawContent,
        'EMAIL_WEBHOOK',
        { sender: fromEmail, recipient: toEmail }
      );
      return NextResponse.json({
        status: 'PROCESSED',
        store_code: store.pos_store_code,
        inbound_address: store.inbound_email_address,
        file_type: 'DOORDASH_CSV',
        ...result,
      });
    } else {
      const result = await ingestPosEjForStore(
        store.id,
        filename,
        rawContent,
        'EMAIL_WEBHOOK',
        { sender: fromEmail, recipient: toEmail }
      );
      return NextResponse.json({
        status: 'PROCESSED',
        store_code: store.pos_store_code,
        inbound_address: store.inbound_email_address,
        file_type: 'POS_EJ',
        ...result,
      });
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Inbound email webhook processing error',
      },
      { status: 500 }
    );
  }
}
