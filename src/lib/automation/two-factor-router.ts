import crypto from 'crypto';
import { getDb } from '@/lib/db';

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Extracts a 6-digit (or 4-8 digit) 2FA verification / OTP code from an email body or subject.
 */
export function extract2faOtpCode(text: string): string | null {
  if (!text) return null;
  const labeledMatch = text.match(
    /(?:verification\s*code|security\s*code|passcode|otp|one-time\s*(?:code|password)|pin)\s*(?:is|:|#|-)?\s*\b(\d{4,8})\b/i
  );
  if (labeledMatch) return labeledMatch[1];

  // Fallback: standalone 6-digit code
  const sixDigitMatch = text.match(/\b(\d{6})\b/);
  return sixDigitMatch ? sixDigitMatch[1] : null;
}

export function detectPlatformFromEmail(
  sender: string,
  subject: string,
  body: string
): 'DOORDASH' | 'UBEREATS' | 'GRUBHUB' {
  const combined = `${sender} ${subject} ${body}`.toLowerCase();
  if (/uber|ubereats/.test(combined)) return 'UBEREATS';
  if (/grubhub/.test(combined)) return 'GRUBHUB';
  return 'DOORDASH';
}

export function extractClientSlugFromDisputeEmail(recipientEmail: string): string {
  // Matches disputes+{client_slug}@claimpilot.app
  const match = recipientEmail.trim().toLowerCase().match(/disputes\+([a-z0-9_-]+)@/i);
  if (match) return match[1];
  return 'windy-city';
}

export async function store2faEmailCode(input: {
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  bodyText: string;
}): Promise<{
  id: string;
  clientSlug: string;
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB';
  otpCode: string;
  expiresAt: string;
} | null> {
  const otpCode = extract2faOtpCode(`${input.subject}\n${input.bodyText}`);
  if (!otpCode) return null;

  const db = await getDb();
  const id = makeId('2fa');
  const clientSlug = extractClientSlugFromDisputeEmail(input.recipientEmail);
  const platform = detectPlatformFromEmail(
    input.senderEmail,
    input.subject,
    input.bodyText
  );
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await db.query(
    `INSERT INTO dispute_2fa_codes (
      id, client_slug, recipient_email, sender_email, platform,
      otp_code, subject, raw_email_snippet, consumed, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9)`,
    [
      id,
      clientSlug,
      input.recipientEmail.trim().toLowerCase(),
      input.senderEmail.trim().toLowerCase(),
      platform,
      otpCode,
      input.subject,
      input.bodyText.slice(0, 500),
      expiresAt,
    ]
  );

  return { id, clientSlug, platform, otpCode, expiresAt };
}

export async function consumeLatest2faCode(
  clientSlug: string,
  platform: 'DOORDASH' | 'UBEREATS' | 'GRUBHUB'
): Promise<{ id: string; otpCode: string } | null> {
  const db = await getDb();
  const res = await db.query<{ id: string; otp_code: string }>(
    `SELECT id, otp_code
     FROM dispute_2fa_codes
     WHERE client_slug = $1
       AND platform = $2
       AND consumed = FALSE
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [clientSlug, platform]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  await db.query(`UPDATE dispute_2fa_codes SET consumed = TRUE WHERE id = $1`, [row.id]);
  return { id: row.id, otpCode: row.otp_code };
}
