import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hashCode, randomCode, randomToken, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { buildInvitationEmail } from "./email.ts";
import { canResend, INTERVIEW_VALID_DAYS, resendsLeft, validateCreate } from "./logic.ts";

// Server-to-server API used by Pathway (and later other clients). Every call needs the shared key in the
// x-witcher-api-key header. The candidate never talks to this function: see the `session` function.

const PRODUCTION_REF = "iwpmsfoovppqnldciric";
const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const envJsonValue = (name: string): string => {
  try {
    const parsed = JSON.parse(Deno.env.get(name) || "{}");
    return String(parsed.default || "");
  } catch {
    return "";
  }
};
const projectUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || envJsonValue("SUPABASE_SECRET_KEYS");
const API_KEY = Deno.env.get("WITCHER_API_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM_ADDRESS = Deno.env.get("EMAIL_FROM") || "onboarding@resend.dev";
// While there is no verified sending domain, every e-mail can be redirected to the owner's own address.
const EMAIL_OVERRIDE_TO = Deno.env.get("EMAIL_OVERRIDE_TO") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://soyfelps.github.io/witcher/").replace(/\/?$/, "/");
// Test mode returns the link and code in the response (so tests need no inbox). Never allowed on production.
const TEST_MODE = Deno.env.get("WITCHER_TEST_MODE") === "1" && !projectUrl.includes(PRODUCTION_REF);
const admin = projectUrl && serviceKey
  ? createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function authorised(req: Request): Promise<boolean> {
  if (!API_KEY) return false;
  const sent = req.headers.get("x-witcher-api-key") || "";
  // Compare hashes so the length of the real key never leaks.
  return timingSafeEqual(await sha256Hex(sent), await sha256Hex(API_KEY));
}

const INTERVIEW_COLUMNS =
  "id,external_id,candidate_name,candidate_email,job_title,role_title,company_name,brand_color,logo_url,link_id,status,invite_count,last_invite_at,expires_at,started_at,last_seen_at,completed_at,cancelled_at,abandoned_at,language_flag,evaluation,impression,q_index,phase";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function publicView(row: Row) {
  return {
    id: row.id,
    externalId: row.external_id,
    status: row.status,
    expiresAt: row.expires_at,
    inviteCount: row.invite_count,
    resendsLeft: resendsLeft(row.invite_count),
    lastInviteAt: row.last_invite_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    abandonedAt: row.abandoned_at,
  };
}

async function sendInvitation(row: Row, code: string, isResend: boolean): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  const mail = buildInvitationEmail({
    name: row.candidate_name,
    jobTitle: row.job_title,
    companyName: row.company_name,
    brandColor: row.brand_color,
    link: `${SITE_URL}interview.html#i=${row.link_id}`,
    code,
    expiresAt: row.expires_at,
    isResend,
  });
  const to = EMAIL_OVERRIDE_TO || row.candidate_email;
  try {
    const result = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${mail.fromName} <${EMAIL_FROM_ADDRESS}>`, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!result.ok) console.error("Invitation e-mail refused:", result.status);
    return result.ok;
  } catch (error) {
    console.error("Invitation e-mail failed:", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

async function newCode() {
  const code = randomCode(6);
  const salt = randomToken(16);
  return { code, salt, hash: await hashCode(salt, code) };
}

async function findInterview(body: Record<string, unknown>): Promise<Row | null> {
  if (!admin) return null;
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : "";
  const externalId = typeof body.externalId === "string" ? body.externalId.slice(0, 200) : "";
  if (!id && !externalId) return null;
  const query = admin.from("interviews").select(INTERVIEW_COLUMNS);
  const { data, error } = id ? await query.eq("id", id).maybeSingle() : await query.eq("source", "pathway").eq("external_id", externalId).maybeSingle();
  if (error) throw error;
  return data;
}

async function actionCreate(body: Record<string, unknown>) {
  const parsed = validateCreate(body);
  if (!parsed.ok) return fail(400, parsed.error);
  const v = parsed.value;

  const existing = await findInterview({ externalId: v.externalId });
  if (existing) return json(200, { ...publicView(existing), emailSent: false, existing: true });

  const { code, salt, hash } = await newCode();
  const { data: row, error } = await admin!.from("interviews").insert({
    source: "pathway",
    external_id: v.externalId,
    candidate_name: v.candidateName,
    candidate_email: v.candidateEmail,
    job_title: v.jobTitle,
    role_title: v.roleTitle,
    company_name: v.companyName,
    brand_color: v.brandColor,
    logo_url: v.logoUrl,
    questions: v.questions,
    code_salt: salt,
    code_hash: hash,
    expires_at: new Date(Date.now() + INTERVIEW_VALID_DAYS * 86400 * 1000).toISOString(),
  }).select(INTERVIEW_COLUMNS).single();
  if (error) {
    if (error.code === "23505") {
      // A retried create raced with the first one: return what already exists.
      const again = await findInterview({ externalId: v.externalId });
      if (again) return json(200, { ...publicView(again), emailSent: false, existing: true });
    }
    throw error;
  }

  const emailSent = await sendInvitation(row, code, false);
  let current = row;
  if (emailSent) {
    const { data: updated, error: updateError } = await admin!.from("interviews")
      .update({ status: "invited", invite_count: 1, last_invite_at: new Date().toISOString() })
      .eq("id", row.id).select(INTERVIEW_COLUMNS).single();
    if (updateError) throw updateError;
    current = updated;
  }
  return json(201, { ...publicView(current), emailSent, ...(TEST_MODE ? { debug: { link: `${SITE_URL}interview.html#i=${row.link_id}`, code } } : {}) });
}

async function actionResend(body: Record<string, unknown>) {
  const row = await findInterview(body);
  if (!row) return fail(404, "not_found");
  const verdict = canResend(row as { status: string; invite_count: number; last_invite_at: string | null }, new Date());
  if (!verdict.ok) return fail(409, verdict.error, verdict.retryAt ? { retryAt: verdict.retryAt } : {});

  // A fresh code each time (the e-mail says so); the link stays the same. Counters only move after the e-mail left.
  const { code, salt, hash } = await newCode();
  const { data: updated, error } = await admin!.from("interviews")
    .update({ code_salt: salt, code_hash: hash, code_attempts: 0, code_locked_until: null })
    .eq("id", row.id).in("status", ["created", "invited"]).eq("invite_count", row.invite_count)
    .select(INTERVIEW_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!updated) return fail(409, "not_resendable");

  const emailSent = await sendInvitation(updated, code, row.invite_count > 0);
  let current = updated;
  if (emailSent) {
    const { data: counted, error: countError } = await admin!.from("interviews")
      .update({ status: "invited", invite_count: row.invite_count + 1, last_invite_at: new Date().toISOString() })
      .eq("id", row.id).select(INTERVIEW_COLUMNS).single();
    if (countError) throw countError;
    current = counted;
  }
  return json(200, { ...publicView(current), emailSent, ...(TEST_MODE ? { debug: { link: `${SITE_URL}interview.html#i=${row.link_id}`, code } } : {}) });
}

async function actionGet(body: Record<string, unknown>) {
  const row = await findInterview(body);
  if (!row) return fail(404, "not_found");
  const view: Record<string, unknown> = { ...publicView(row), lastSeenAt: row.last_seen_at };
  if (row.status === "completed") {
    const { data: messages, error } = await admin!.from("interview_messages")
      .select("seq,role,kind,body,audio_seconds,answer_status,created_at").eq("interview_id", row.id).order("seq");
    if (error) throw error;
    view.evaluation = row.evaluation;
    view.impression = row.impression;
    view.languageFlag = row.language_flag;
    view.messages = messages;
  }
  return json(200, view);
}

async function actionCancel(body: Record<string, unknown>) {
  const row = await findInterview(body);
  if (!row) return fail(404, "not_found");
  if (row.status === "cancelled") return json(200, publicView(row));
  if (row.status === "completed" || row.status === "abandoned" || row.status === "expired") return fail(409, "not_cancellable", { status: row.status });
  const { data: updated, error } = await admin!.from("interviews")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), session_hash: null, session_expires_at: null })
    .eq("id", row.id).in("status", ["created", "invited", "in_progress"]).select(INTERVIEW_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!updated) return fail(409, "not_cancellable");
  // A cancelled interview keeps no transcript.
  const { error: deleteError } = await admin!.from("interview_messages").delete().eq("interview_id", row.id);
  if (deleteError) throw deleteError;
  return json(200, publicView(updated));
}

async function actionDelete(body: Record<string, unknown>) {
  const row = await findInterview(body);
  if (!row) return json(200, { deleted: false }); // already gone: deleting is idempotent
  const { error } = await admin!.from("interviews").delete().eq("id", row.id);
  if (error) throw error;
  return json(200, { deleted: true });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  if (!admin || !API_KEY) return fail(503, "not_configured");
  if (!(await authorised(req))) return fail(401, "unauthorised");
  const body = await readBody(req);
  if (!body) return fail(400, "invalid_body");
  try {
    switch (body.action) {
      case "create": return await actionCreate(body);
      case "get": return await actionGet(body);
      case "resend": return await actionResend(body);
      case "cancel": return await actionCancel(body);
      case "delete": return await actionDelete(body);
      default: return fail(400, "unknown_action");
    }
  } catch (error) {
    console.error("interviews-api error:", error instanceof Error ? error.message : "unknown error");
    return fail(500, "server_error");
  }
});
