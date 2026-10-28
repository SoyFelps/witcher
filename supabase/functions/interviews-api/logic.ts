// Pure rules of the interviews API (validation, resend limits). No Deno or network access: tested in Node.

export const MAX_QUESTIONS = 5;
export const MAX_RESENDS = 3;
export const RESEND_MIN_HOURS = 24;
export const INTERVIEW_VALID_DAYS = 7;

const CONTROL_CHARACTERS = new RegExp(`[\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** One line of plain text: control characters removed, whitespace collapsed, length capped. */
export function singleLine(value: unknown, max: number): string {
  return String(value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface CreateInput {
  externalId: string;
  candidateName: string;
  candidateEmail: string;
  jobTitle: string;
  roleTitle: string | null;
  companyName: string;
  brandColor: string | null;
  logoUrl: string | null;
  questions: string[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates and cleans the body of a `create` call. Returns a short error code instead of throwing. */
export function validateCreate(body: Record<string, unknown>): Validated<CreateInput> {
  const externalId = singleLine(body.externalId, 200);
  if (!externalId) return { ok: false, error: "externalId_required" };

  const candidate = (body.candidate ?? {}) as Record<string, unknown>;
  const candidateName = singleLine(candidate.name, 120);
  if (!candidateName) return { ok: false, error: "candidate_name_required" };
  const candidateEmail = singleLine(candidate.email, 254).toLowerCase();
  if (!EMAIL_RE.test(candidateEmail)) return { ok: false, error: "candidate_email_invalid" };

  const jobTitle = singleLine(body.jobTitle, 120);
  if (!jobTitle) return { ok: false, error: "jobTitle_required" };
  const roleTitle = singleLine(body.roleTitle, 120) || null;

  const company = (body.company ?? {}) as Record<string, unknown>;
  const companyName = singleLine(company.name, 80);
  if (!companyName) return { ok: false, error: "company_name_required" };
  const rawColor = singleLine(company.color, 7);
  if (rawColor && !COLOR_RE.test(rawColor)) return { ok: false, error: "company_color_invalid" };
  const rawLogo = singleLine(company.logoUrl, 500);
  let logoUrl: string | null = null;
  if (rawLogo) {
    try {
      const url = new URL(rawLogo);
      if (url.protocol !== "https:") return { ok: false, error: "company_logo_invalid" };
      logoUrl = url.toString();
    } catch {
      return { ok: false, error: "company_logo_invalid" };
    }
  }

  if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: "questions_invalid" };
  }
  const questions = body.questions.map((question) => singleLine(question, 500));
  if (questions.some((question) => question.length < 3)) return { ok: false, error: "questions_invalid" };

  return {
    ok: true,
    value: { externalId, candidateName, candidateEmail, jobTitle, roleTitle, companyName, brandColor: rawColor || null, logoUrl, questions },
  };
}

export interface ResendState {
  status: string;
  invite_count: number;
  last_invite_at: string | null;
}

export type ResendVerdict =
  | { ok: true }
  | { ok: false; error: "not_resendable" | "resend_limit" | "resend_too_soon"; retryAt?: string };

/**
 * Re-send rules (owner decision 2026-10-27): only while the candidate has not started, at most 3 re-sends per
 * interview, at most one every 24 hours. The first send does not count as a re-send, and an interview whose first
 * e-mail failed (invite_count 0) can always be sent.
 */
export function canResend(row: ResendState, now: Date): ResendVerdict {
  if (row.status !== "created" && row.status !== "invited") return { ok: false, error: "not_resendable" };
  if (row.invite_count === 0 || !row.last_invite_at) return { ok: true };
  if (row.invite_count - 1 >= MAX_RESENDS) return { ok: false, error: "resend_limit" };
  const next = new Date(Date.parse(row.last_invite_at) + RESEND_MIN_HOURS * 3600 * 1000);
  if (now < next) return { ok: false, error: "resend_too_soon", retryAt: next.toISOString() };
  return { ok: true };
}

export function resendsLeft(inviteCount: number): number {
  return Math.max(0, MAX_RESENDS - Math.max(0, inviteCount - 1));
}

/** `a***@example.com`: enough to recognise the address, not enough to reveal it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
