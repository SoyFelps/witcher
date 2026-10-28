import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { BATCH_SIZE, buildEventPayload, LEASE_SECONDS, MAX_ATTEMPTS, type NotifyRow, retryDelayMinutes, signBody } from "./webhook.ts";

// Sends the "interview finished / abandoned / expired" notices to Pathway. A database job calls this every minute, and it
// is harmless to call by hand: it only works on rows still marked pending, each one at most once per retry delay, and
// Pathway checks the signature. Without PATHWAY_WEBHOOK_URL and WITCHER_WEBHOOK_SECRET it does nothing.

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
const WEBHOOK_URL = Deno.env.get("PATHWAY_WEBHOOK_URL") || "";
const WEBHOOK_SECRET = Deno.env.get("WITCHER_WEBHOOK_SECRET") || "";
const admin = projectUrl && serviceKey
  ? createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const COLUMNS = "id,external_id,status,notify_event,impression,evaluation,completed_at,abandoned_at,language_flag,notify_attempts";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function post(row: NotifyRow): Promise<boolean> {
  const body = JSON.stringify(buildEventPayload(row, new Date()));
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const result = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-witcher-timestamp": String(timestamp),
        "x-witcher-signature": await signBody(WEBHOOK_SECRET, timestamp, body),
      },
      body,
      signal: controller.signal,
    });
    if (!result.ok) console.error("Webhook refused:", result.status);
    return result.ok;
  } catch (error) {
    console.error("Webhook failed:", error instanceof Error ? error.message : "unknown error");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const now = new Date();
  const { data: due, error } = await admin!.from("interviews").select("id")
    .eq("source", "pathway").eq("notify_state", "pending")
    .or(`notify_next_at.is.null,notify_next_at.lte.${now.toISOString()}`)
    .order("created_at").limit(BATCH_SIZE);
  if (error) throw error;
  if (!due?.length) return { due: 0, sent: 0, failed: 0 };

  // Take a lease on the rows first, so two overlapping runs never send the same notice twice.
  const { data: rows, error: leaseError } = await admin!.from("interviews")
    .update({ notify_next_at: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString() })
    .in("id", due.map((row) => row.id)).eq("notify_state", "pending")
    .or(`notify_next_at.is.null,notify_next_at.lte.${now.toISOString()}`)
    .select(COLUMNS);
  if (leaseError) throw leaseError;

  let sent = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    if (await post(row as NotifyRow)) {
      const { error: doneError } = await admin!.from("interviews")
        .update({ notify_state: "sent", notified_at: new Date().toISOString(), notify_next_at: null, notify_attempts: row.notify_attempts + 1 })
        .eq("id", row.id).eq("notify_event", row.notify_event);
      if (doneError) throw doneError;
      sent++;
    } else {
      const attempts = row.notify_attempts + 1;
      const delay = retryDelayMinutes(attempts);
      const { error: failError } = await admin!.from("interviews")
        .update({
          notify_attempts: attempts,
          notify_state: attempts >= MAX_ATTEMPTS || delay === null ? "failed" : "pending",
          notify_next_at: delay === null ? null : new Date(Date.now() + delay * 60_000).toISOString(),
        })
        .eq("id", row.id).eq("notify_event", row.notify_event);
      if (failError) throw failError;
      failed++;
    }
  }
  return { due: rows?.length ?? 0, sent, failed };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!admin) return reply(503, { error: "not_configured" });
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) return reply(200, { skipped: "webhook_not_configured" });
  try {
    return reply(200, await run());
  } catch (error) {
    console.error("deliver error:", error instanceof Error ? error.message : "unknown error");
    return reply(500, { error: "server_error" });
  }
});
