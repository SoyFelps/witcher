// Pure rules of the result webhook sent to Pathway (signing, payload, retry schedule). No Deno or network access:
// tested in Node. The payload carries no candidate data and no evaluation; Pathway asks for those through the API.

export const MAX_ATTEMPTS = 8;
export const BATCH_SIZE = 20;
export const LEASE_SECONDS = 120; // while one run delivers a row, no other run takes it
export const SIGNATURE_TOLERANCE_SECONDS = 300; // Pathway rejects a call older than this
const RETRY_MINUTES = [1, 2, 5, 15, 60, 240, 720];

export interface NotifyRow {
  id: string;
  external_id: string;
  status: string;
  notify_event: string;
  impression: string | null;
  evaluation: string | null;
  completed_at: string | null;
  abandoned_at: string | null;
  language_flag: boolean;
}

/** What is sent. `evaluationReady` is false when the AI could not write the evaluation (Pathway then offers a retry). */
export function buildEventPayload(row: NotifyRow, now: Date) {
  return {
    event: row.notify_event,
    sentAt: now.toISOString(),
    interview: {
      id: row.id,
      externalId: row.external_id,
      status: row.status,
      impression: row.impression,
      languageFlag: row.language_flag,
      completedAt: row.completed_at,
      abandonedAt: row.abandoned_at,
      evaluationReady: Boolean(row.evaluation) && row.impression !== null,
    },
  };
}

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `v1=<hex>`: HMAC-SHA256 of `<timestamp>.<body>` with the shared secret. The timestamp is in whole seconds. */
export async function signBody(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `v1=${toHex(signature)}`;
}

/** Minutes to wait before the next try, after `attempts` failed tries; null when it is time to give up. */
export function retryDelayMinutes(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return RETRY_MINUTES[Math.min(Math.max(attempts, 1) - 1, RETRY_MINUTES.length - 1)];
}
