import { Resend } from 'resend'
import { env } from '../../lib/env'

/**
 * Lightweight transactional-email wrapper around Resend.
 *
 * Behavior:
 *   - If RESEND_API_KEY is set → sends via Resend.
 *   - If RESEND_API_KEY is unset AND NODE_ENV !== 'production' → logs the OTP to
 *     stdout so devs can test the flow without configuring Resend.
 *   - If RESEND_API_KEY is unset AND NODE_ENV === 'production' → throws.
 *
 * The from address defaults to `noreply@<your-domain>` derived from RESEND_FROM_EMAIL,
 * or falls back to Resend's sandbox `onboarding@resend.dev` (only delivers to the
 * email you signed up with — perfect for first-time smoke tests before domain DNS
 * is verified).
 */

let cachedClient: Resend | null = null
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null
  if (!cachedClient) {
    cachedClient = new Resend(env.RESEND_API_KEY)
  }
  return cachedClient
}

function fromAddress(): string {
  return env.RESEND_FROM_EMAIL || 'Godslandx <onboarding@resend.dev>'
}

function appName(): string {
  return env.APP_NAME || 'Godslandx'
}

function appUrl(): string {
  return env.FRONTEND_URL || env.APP_BASE_URL || 'https://trade.godslandx.com'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface VerificationEmailParams {
  to: string
  code: string
  /** TTL of the code in minutes — surfaced in the email copy. */
  expiresInMinutes: number
}

export async function sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
  const { to, code, expiresInMinutes } = params
  const client = getClient()
  const safeCode = escapeHtml(code)
  const safeName = escapeHtml(appName())
  const safeUrl = escapeHtml(appUrl())

  if (!client) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'RESEND_API_KEY is not configured — cannot send verification emails in production',
      )
    }
    // Dev fallback: log the code so devs can finish the flow without configuring Resend.
    // Stays single-line so it's easy to grep in container logs.
    console.warn(
      `[emailService] DEV MODE — would send verification email to ${to} with code ${code} (expires in ${expiresInMinutes} min)`,
    )
    return
  }

  const subject = `Your ${appName()} verification code`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;color:#e2e8f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0f14;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#0f1722;border:1px solid rgba(16,185,129,0.25);border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:32px 32px 8px 32px;">
            <p style="margin:0 0 4px 0;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10px;letter-spacing:3px;color:#10b981;text-transform:uppercase;">// secure access</p>
            <h1 style="margin:0;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:22px;letter-spacing:0.5px;color:#ffffff;">${safeName}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 24px 32px;">
            <p style="margin:0;font-size:14px;line-height:1.6;color:#cbd5e1;">Welcome — please use the code below to verify your email address and finish creating your account.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px 32px;" align="center">
            <div style="display:inline-block;background-color:#0b1320;border:1px solid rgba(16,185,129,0.4);border-radius:10px;padding:18px 28px;">
              <span style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;letter-spacing:10px;color:#10b981;font-weight:600;">${safeCode}</span>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px 32px;">
            <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#94a3b8;">This code expires in <strong style="color:#e2e8f0;">${expiresInMinutes} minutes</strong>. Enter it on the verification page to activate your account.</p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">Didn't try to sign up? You can safely ignore this email — your address won't be used.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 32px 32px;border-top:1px solid rgba(148,163,184,0.1);">
            <p style="margin:0;font-size:11px;line-height:1.6;color:#475569;font-family:'SF Mono',Menlo,Consolas,monospace;">
              ${safeName} · <a href="${safeUrl}" style="color:#10b981;text-decoration:none;">${safeUrl}</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = [
    `${appName()} verification code`,
    '',
    `Your verification code is: ${code}`,
    '',
    `This code expires in ${expiresInMinutes} minutes.`,
    '',
    `If you didn't try to sign up, you can safely ignore this email.`,
    '',
    `— ${appName()}`,
    appUrl(),
  ].join('\n')

  const result = await client.emails.send({
    from: fromAddress(),
    to,
    subject,
    html,
    text,
  })

  if (result.error) {
    const message =
      typeof result.error === 'object' && result.error && 'message' in result.error
        ? String((result.error as { message?: unknown }).message ?? 'unknown error')
        : String(result.error)
    throw new Error(`Resend send failed: ${message}`)
  }
}
