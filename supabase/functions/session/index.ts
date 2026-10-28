import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hashCode, randomToken, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { type AiProvider, stubProvider, type TranscriptLine } from "./ai.ts";
import { createGeminiProvider } from "./gemini.ts";
import {
  ABANDON_AFTER_SECONDS,
  ANSWER_SECONDS,
  answerAllowed,
  CODE_LOCK_SECONDS,
  CODE_MAX_ATTEMPTS,
  CONSENT_VERSION,
  firstName,
  impressionFor,
  isEnglish,
  maskEmail,
  MAX_AUDIO_BASE64_CHARS,
  nextStep,
  normaliseCode,
  type Phase,
  secondsLeft,
  SESSION_HOURS,
} from "./flow.ts";

// Everything the candidate's browser does goes through here. The browser never reads a table. Audio is held in
// memory for one AI call and then dropped; only the transcript is saved. Candidate content is never logged.

const PRODUCTION_REF = "iwpmsfoovppqnldciric";
const APP_ORIGINS = new Set([
  "https://soyfelps.github.io",
  "http://localhost:8001",
  "http://127.0.0.1:8001",
]);
const MAX_BODY_BYTES = MAX_AUDIO_BASE64_CHARS + 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOLLOW_UP_FALLBACK = "Thank you. Could you tell me a bit more about that?";
const CLOSING_TEXT = "Thank you for your time. Your answers were sent to the hiring team.";

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
const admin = projectUrl && serviceKey
  ? createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// The real AI is Gemini (needs the GEMINI_API_KEY secret). AI_PROVIDER=stub switches on the offline stub for tests,
// and it is never allowed on production. Without a key (and no stub) the interview answers "ai_not_configured".
let gemini: AiProvider | null = null;
function aiProvider(): AiProvider | null {
  const choice = Deno.env.get("AI_PROVIDER") || "gemini";
  if (choice === "stub") return projectUrl.includes(PRODUCTION_REF) ? null : stubProvider;
  const apiKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (!apiKey) return null;
  return gemini ??= createGeminiProvider({ apiKey });
}

function response(req: Request, status: number, body: unknown) {
  const origin = req.headers.get("origin") || "";
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" });
  if (origin && APP_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, x-client-info, content-type");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return status === 204 ? new Response(null, { status, headers }) : new Response(JSON.stringify(body), { status, headers });
}
const fail = (req: Request, status: number, error: string, extra: Record<string, unknown> = {}) => response(req, status, { error, ...extra });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text(); // sendBeacon sends text/plain, so the content type is not checked
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const SESSION_COLUMNS =
  "id,link_id,status,candidate_name,candidate_email,job_title,role_title,company_name,brand_color,logo_url,questions,expires_at,consent_at,q_index,phase,step_started_at,last_seen_at,session_expires_at,language_flag";

async function byLink(linkId: unknown): Promise<Row | null> {
  if (typeof linkId !== "string" || !UUID_RE.test(linkId)) return null;
  const { data, error } = await admin!.from("interviews").select(SESSION_COLUMNS + ",code_salt,code_hash,code_locked_until").eq("link_id", linkId).maybeSingle();
  if (error) throw error;
  return data ? await settle(data) : null;
}

async function bySession(token: unknown): Promise<Row | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const { data, error } = await admin!.from("interviews").select(SESSION_COLUMNS).eq("session_hash", await sha256Hex(token)).maybeSingle();
  if (error) throw error;
  if (!data || !data.session_expires_at || Date.parse(data.session_expires_at) <= Date.now()) return null;
  return await settle(data);
}

/** Applies what time has already decided: an unused invitation past its date expires, a silent interview is abandoned. */
async function settle(row: Row): Promise<Row> {
  if ((row.status === "created" || row.status === "invited") && Date.parse(row.expires_at) < Date.now()) {
    await admin!.from("interviews").update({ status: "expired", notify_event: "expired", notify_state: "pending", session_hash: null, session_expires_at: null })
      .eq("id", row.id).in("status", ["created", "invited"]);
    return { ...row, status: "expired" };
  }
  if (row.status === "in_progress" && row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) > ABANDON_AFTER_SECONDS * 1000) {
    const { error } = await admin!.rpc("witcher_abandon", { p_id: row.id });
    if (error) throw error;
    return { ...row, status: "abandoned" };
  }
  return row;
}

const branding = (row: Row) => ({
  company: row.company_name,
  color: row.brand_color,
  logoUrl: row.logo_url,
  jobTitle: row.job_title,
  roleTitle: row.role_title,
});

async function lastSeq(interviewId: string): Promise<number> {
  const { data, error } = await admin!.from("interview_messages").select("seq").eq("interview_id", interviewId).order("seq", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0]?.seq ?? 0;
}

async function addMessages(interviewId: string, items: { role: "ai" | "candidate"; kind: string; body: string | null; audioSeconds?: number | null; answerStatus?: string | null }[]) {
  let seq = await lastSeq(interviewId);
  const rows = items.map((item) => ({
    interview_id: interviewId,
    seq: ++seq,
    role: item.role,
    kind: item.kind,
    body: item.body,
    audio_seconds: item.audioSeconds ?? null,
    answer_status: item.answerStatus ?? null,
  }));
  const { error } = await admin!.from("interview_messages").insert(rows);
  if (error) throw error;
}

// ---------------------------------------------------------------------------------------------------------

async function actionOpen(req: Request, body: Record<string, unknown>) {
  const row = await byLink(body.linkId);
  if (!row || row.status === "created") return fail(req, 404, "unavailable");
  return response(req, 200, { state: row.status, branding: branding(row), emailMasked: maskEmail(row.candidate_email) });
}

async function actionVerify(req: Request, body: Record<string, unknown>) {
  const row = await byLink(body.linkId);
  if (!row || row.status === "created") return fail(req, 404, "unavailable");
  if (row.status !== "invited") return fail(req, 409, "state", { state: row.status });
  if (row.code_locked_until && Date.parse(row.code_locked_until) > Date.now()) {
    return fail(req, 429, "locked", { retryAt: row.code_locked_until });
  }
  const code = normaliseCode(body.code);
  const ok = code.length === 6 && row.code_salt && row.code_hash && timingSafeEqual(await hashCode(row.code_salt, code), row.code_hash);
  if (!ok) {
    const { data, error } = await admin!.rpc("witcher_code_failure", { p_id: row.id, p_max: CODE_MAX_ATTEMPTS, p_lock_seconds: CODE_LOCK_SECONDS });
    if (error) throw error;
    const lockedUntil = data?.[0]?.locked_until ?? null;
    const locked = lockedUntil && Date.parse(lockedUntil) > Date.now();
    const used = Number(data?.[0]?.attempts ?? 0);
    return fail(req, locked ? 429 : 401, locked ? "locked" : "invalid_code", locked ? { retryAt: lockedUntil } : { attemptsLeft: Math.max(0, CODE_MAX_ATTEMPTS - used) });
  }
  const token = randomToken(32);
  const { error } = await admin!.from("interviews").update({
    session_hash: await sha256Hex(token),
    session_expires_at: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
    code_attempts: 0,
    code_locked_until: null,
  }).eq("id", row.id).eq("status", "invited");
  if (error) throw error;
  // The first name is only revealed after the right code, so a forwarded or guessed link never shows it.
  return response(req, 200, { sessionToken: token, consentVersion: CONSENT_VERSION, totalQuestions: (row.questions as unknown[]).length, branding: branding(row), candidateFirstName: firstName(row.candidate_name) });
}

async function actionConsent(req: Request, body: Record<string, unknown>) {
  const row = await bySession(body.sessionToken);
  if (!row) return fail(req, 401, "session");
  if (row.status !== "invited") return fail(req, 409, "state", { state: row.status });
  if (body.accepted !== true || body.version !== CONSENT_VERSION) return fail(req, 400, "consent_required");
  const { error } = await admin!.from("interviews").update({ consent_version: CONSENT_VERSION, consent_at: new Date().toISOString() }).eq("id", row.id).eq("status", "invited");
  if (error) throw error;
  return response(req, 200, { ok: true });
}

async function actionStart(req: Request, body: Record<string, unknown>) {
  const row = await bySession(body.sessionToken);
  if (!row) return fail(req, 401, "session");
  if (row.status !== "invited") return fail(req, 409, "state", { state: row.status });
  if (!row.consent_at) return fail(req, 400, "consent_required");
  const now = new Date().toISOString();
  const { data: claimed, error } = await admin!.from("interviews")
    .update({ status: "in_progress", started_at: now, last_seen_at: now, step_started_at: now, q_index: 0, phase: "question" })
    .eq("id", row.id).eq("status", "invited").select("id").maybeSingle();
  if (error) throw error;
  if (!claimed) return fail(req, 409, "state", { state: "in_progress" });
  const questions = row.questions as string[];
  await addMessages(row.id, [{ role: "ai", kind: "question", body: questions[0] }]);
  return response(req, 200, { prompt: { qIndex: 0, phase: "question", text: questions[0] }, totalQuestions: questions.length, secondsLeft: ANSWER_SECONDS });
}

async function actionHeartbeat(req: Request, body: Record<string, unknown>) {
  const row = await bySession(body.sessionToken);
  if (!row) return fail(req, 401, "session");
  if (row.status !== "in_progress") return response(req, 200, { state: row.status });
  const { error } = await admin!.from("interviews").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id).eq("status", "in_progress");
  if (error) throw error;
  return response(req, 200, { state: "in_progress", secondsLeft: secondsLeft(row.step_started_at, new Date()) });
}

async function actionAnswer(req: Request, body: Record<string, unknown>) {
  const row = await bySession(body.sessionToken);
  if (!row) return fail(req, 401, "session");
  if (row.status !== "in_progress") return fail(req, 409, "state", { state: row.status });
  const position = { qIndex: row.q_index as number, phase: row.phase as Phase };
  if (body.qIndex !== position.qIndex || body.phase !== position.phase) {
    return fail(req, 409, "out_of_sync", { ...position, secondsLeft: secondsLeft(row.step_started_at, new Date()) });
  }

  const skipped = body.skip === true;
  let analysis = { transcript: "", onTopic: true, offensive: false, language: "en", followUp: null as string | null };
  const questions = row.questions as string[];
  const questionText = position.phase === "question" ? questions[position.qIndex] : null;
  const durationSeconds = Math.max(0, Math.min(ANSWER_SECONDS, Math.round(Number(body.durationSeconds) || 0)));

  if (!skipped) {
    if (!answerAllowed(row.step_started_at, new Date())) return fail(req, 409, "time_over");
    const audio = body.audio;
    if (typeof audio !== "string" || audio.length < 4 || audio.length > MAX_AUDIO_BASE64_CHARS) return fail(req, 400, "audio_invalid");
    const mimeType = typeof body.mimeType === "string" ? body.mimeType.slice(0, 80) : "audio/webm";
    const provider = aiProvider();
    if (!provider) return fail(req, 503, "ai_not_configured");
    // The question this answer belongs to (the follow-up text is the last AI message).
    let promptText = questionText;
    if (position.phase === "followup") {
      const { data: last } = await admin!.from("interview_messages").select("body").eq("interview_id", row.id).eq("role", "ai").order("seq", { ascending: false }).limit(1);
      promptText = last?.[0]?.body ?? questions[position.qIndex];
    }
    try {
      analysis = await provider.analyseAnswer({
        job: row.job_title,
        role: row.role_title,
        company: row.company_name,
        question: promptText ?? "",
        isFollowUp: position.phase === "followup",
        audioBase64: audio,
        mimeType,
        durationSeconds,
      });
    } catch (error) {
      console.error("AI analysis failed:", error instanceof Error ? error.message : "unknown error");
      return fail(req, 502, "ai_unavailable");
    }
  }

  const next = nextStep(position, questions.length, { skipped, onTopic: analysis.onTopic, offensive: analysis.offensive });
  const now = new Date().toISOString();
  const languageFlag = Boolean(row.language_flag) || (!skipped && !isEnglish(analysis.language));

  // Claim the step first, so a double click or a retry can never answer the same question twice.
  const update: Record<string, unknown> = { last_seen_at: now, language_flag: languageFlag };
  if (next.kind === "followup") Object.assign(update, { phase: "followup", step_started_at: now });
  else if (next.kind === "question") Object.assign(update, { q_index: next.qIndex, phase: "question", step_started_at: now });
  else Object.assign(update, { status: "completed", completed_at: now, step_started_at: null, session_hash: null, session_expires_at: null });
  const { data: claimed, error: claimError } = await admin!.from("interviews").update(update)
    .eq("id", row.id).eq("status", "in_progress").eq("q_index", position.qIndex).eq("phase", position.phase).select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return fail(req, 409, "out_of_sync");

  const toSave: Parameters<typeof addMessages>[1] = [{
    role: "candidate", kind: "answer", body: skipped ? null : analysis.transcript, audioSeconds: skipped ? null : durationSeconds,
    answerStatus: skipped ? "skipped" : "submitted",
  }];

  if (next.kind === "followup") {
    const text = (analysis.followUp || FOLLOW_UP_FALLBACK).slice(0, 500);
    toSave.push({ role: "ai", kind: "followup", body: text });
    await addMessages(row.id, toSave);
    return response(req, 200, { prompt: { qIndex: position.qIndex, phase: "followup", text }, secondsLeft: ANSWER_SECONDS });
  }
  if (next.kind === "question") {
    toSave.push({ role: "ai", kind: "question", body: questions[next.qIndex] });
    await addMessages(row.id, toSave);
    return response(req, 200, { prompt: { qIndex: next.qIndex, phase: "question", text: questions[next.qIndex] }, secondsLeft: ANSWER_SECONDS });
  }

  // Last answer: save it and close the conversation. The evaluation is written after the response, so the candidate
  // sees the thank-you screen at once (it can take a while when Google is busy). Until it is written the
  // interview is completed with no evaluation yet.
  toSave.push({ role: "ai", kind: "closing", body: CLOSING_TEXT });
  await addMessages(row.id, toSave);
  const evaluation = finish(row, languageFlag).catch((error) => console.error("finish failed:", error instanceof Error ? error.message : "unknown error"));
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") runtime.waitUntil(evaluation);
  else await evaluation;
  return response(req, 200, { done: true });
}

async function finish(row: Row, languageFlag: boolean) {
  const provider = aiProvider();
  let evaluation = "The evaluation could not be generated automatically. Please review the transcript.";
  let aiImpression: "positive" | "negative" | null = null; // stays null when the AI fails: an outage must not hurt the candidate
  if (provider) {
    try {
      const { data, error } = await admin!.from("interview_messages").select("role,kind,body").eq("interview_id", row.id).order("seq");
      if (error) throw error;
      const result = await provider.evaluate({ job: row.job_title, role: row.role_title, company: row.company_name, lines: (data ?? []) as TranscriptLine[] });
      evaluation = result.evaluation.slice(0, 6000);
      aiImpression = result.impression;
    } catch (error) {
      console.error("AI evaluation failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
  const { error } = await admin!.from("interviews")
    .update({ evaluation, impression: impressionFor(languageFlag, aiImpression), notify_event: "completed", notify_state: "pending" })
    .eq("id", row.id);
  if (error) throw error;
}

async function actionLeave(req: Request, body: Record<string, unknown>) {
  // Sent by the page when it closes. Only a started interview is cancelled; before the first question the
  // candidate may leave and come back.
  const row = await bySession(body.sessionToken);
  if (row && row.status === "in_progress") {
    const { error } = await admin!.rpc("witcher_abandon", { p_id: row.id });
    if (error) throw error;
  }
  return response(req, 200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return response(req, 204, null);
  if (req.method !== "POST") return fail(req, 405, "method_not_allowed");
  if (!admin) return fail(req, 503, "not_configured");
  const body = await readBody(req);
  if (!body) return fail(req, 400, "invalid_body");
  try {
    switch (body.action) {
      case "open": return await actionOpen(req, body);
      case "verify": return await actionVerify(req, body);
      case "consent": return await actionConsent(req, body);
      case "start": return await actionStart(req, body);
      case "heartbeat": return await actionHeartbeat(req, body);
      case "answer": return await actionAnswer(req, body);
      case "leave": return await actionLeave(req, body);
      default: return fail(req, 400, "unknown_action");
    }
  } catch (error) {
    console.error("session error:", error instanceof Error ? error.message : "unknown error");
    return fail(req, 500, "server_error");
  }
});
