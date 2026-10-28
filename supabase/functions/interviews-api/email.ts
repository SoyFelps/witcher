// Interview invitation e-mail: pure helpers with no Deno or network access, so they can be unit-tested in Node.
// E-mail clients cannot read CSS variables, so the brand colours below are written out on purpose.

export interface InvitationInput {
  name: string;
  jobTitle: string;
  companyName: string;
  brandColor?: string | null;
  link: string;
  code: string;
  expiresAt: string;
  isResend?: boolean;
}

export interface InvitationEmail {
  subject: string;
  text: string;
  html: string;
  fromName: string;
}

const CONTROL_CHARACTERS = new RegExp(`[\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]`, "g");

function singleLine(value: unknown, max: number): string {
  return String(value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display name for the From header: no quotes, angle brackets or other characters that could break the header. */
export function safeDisplayName(value: string): string {
  return singleLine(value, 60).replace(/["<>@\\,;:()[\]]/g, "").trim() || "Witcher";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function buildInvitationEmail(input: InvitationInput): InvitationEmail {
  const name = singleLine(input.name, 120) || "there";
  const job = singleLine(input.jobTitle, 120) || "the open role";
  const company = singleLine(input.companyName, 80) || "the hiring team";
  const accent = /^#[0-9a-fA-F]{6}$/.test(input.brandColor || "") ? String(input.brandColor) : "#315f4a";
  const until = formatDate(input.expiresAt);

  const subject = singleLine(`${input.isResend ? "Reminder: your" : "Your"} interview for ${job} at ${company}`, 200);
  const text = [
    `Hi ${name},`,
    "",
    `${company} invites you to a short interview for ${job}. An AI assistant asks a few questions and you answer out loud. The company reviews your answers; the AI does not decide who moves forward.`,
    "",
    `Start here: ${input.link}`,
    `Your access code: ${input.code}`,
    ...(input.isResend ? ["(This code replaces any code from an earlier e-mail.)"] : []),
    "",
    until ? `The invitation is valid until ${until}. You will need a quiet place and a working microphone.` : "You will need a quiet place and a working microphone.",
    "",
    `This is an automated message sent by Witcher on behalf of ${company}. Please do not reply to this e-mail.`,
  ].join("\n");

  const n = escapeHtml(name);
  const j = escapeHtml(job);
  const c = escapeHtml(company);
  const link = escapeHtml(input.link);
  const code = escapeHtml(input.code);
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f8f8f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17251e;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e9e4;border-radius:12px;">
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${accent};font-weight:700;">${input.isResend ? "Interview reminder" : "Interview invitation"}</p>
                <h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#17251e;">Hi ${n}, you are invited to an interview.</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#34463a;"><strong>${c}</strong> invites you to a short interview for <strong>${j}</strong>. An AI assistant asks a few questions and you answer out loud. The company reviews your answers; the AI does not decide who moves forward.</p>
                <p style="margin:0 0 8px;font-size:13px;color:#748178;">Your access code${input.isResend ? " (replaces any earlier code)" : ""}</p>
                <p style="margin:0 0 24px;font-size:30px;letter-spacing:.3em;font-weight:700;color:#17251e;">${code}</p>
                <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${accent};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Start your interview</a></p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#748178;">${escapeHtml(until ? `Valid until ${until}. ` : "")}You will need a quiet place and a working microphone.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #edf1ed;font-size:12px;line-height:1.5;color:#748178;">
                Automated message sent by Witcher on behalf of ${c}. Please do not reply to this e-mail.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html, fromName: safeDisplayName(`${company} via Witcher`) };
}
