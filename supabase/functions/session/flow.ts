// Pure rules of the candidate interview (state machine, timer, impression). No Deno or network access: tested in Node.

export const ANSWER_SECONDS = 180; // 3 minutes per answer (owner decision)
export const GRACE_SECONDS = 120; // after the 3 minutes, a recording the timer cut short can still be listened to and sent for this long
export const ABANDON_AFTER_SECONDS = 90; // no sign of life for this long = the candidate left (also in witcher_sweep)
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LOCK_SECONDS = 15 * 60;
export const SESSION_HOURS = 3;
export const CONSENT_VERSION = "2026-10-28-v1";
export const MAX_AUDIO_BASE64_CHARS = 14_000_000; // about 10 MB of audio, far more than 3 minutes of speech

export type Phase = "question" | "followup";
export interface Position { qIndex: number; phase: Phase }
export type Next = { kind: "followup" } | { kind: "question"; qIndex: number } | { kind: "done" };

/**
 * What happens after an answer. A follow-up is asked only after a real answer to a main question: no follow-up
 * when the answer was skipped, did not address the question, or was offensive. After a follow-up, or when there is
 * none, the next main question comes; after the last one the interview is done.
 */
export function nextStep(
  position: Position,
  totalQuestions: number,
  result: { skipped: boolean; onTopic: boolean; offensive: boolean },
): Next {
  if (position.phase === "question" && !result.skipped && result.onTopic && !result.offensive) return { kind: "followup" };
  const nextIndex = position.qIndex + 1;
  return nextIndex < totalQuestions ? { kind: "question", qIndex: nextIndex } : { kind: "done" };
}

/** Whole seconds left on the answer timer, never below 0 or above the limit. */
export function secondsLeft(stepStartedAt: string | null, now: Date): number {
  if (!stepStartedAt) return ANSWER_SECONDS;
  const elapsed = (now.getTime() - Date.parse(stepStartedAt)) / 1000;
  return Math.max(0, Math.min(ANSWER_SECONDS, Math.ceil(ANSWER_SECONDS - elapsed)));
}

/** A recorded answer is accepted until the limit plus the grace time (the person may be listening to it). Skipping is always allowed. */
export function answerAllowed(stepStartedAt: string | null, now: Date): boolean {
  if (!stepStartedAt) return false;
  return (now.getTime() - Date.parse(stepStartedAt)) / 1000 <= ANSWER_SECONDS + GRACE_SECONDS;
}

/** When the AI cannot tell the language, the candidate is not punished. */
export function isEnglish(language: string | null | undefined): boolean {
  const code = String(language ?? "").trim().toLowerCase();
  return code === "" || code === "und" || code === "unknown" || code === "en" || code.startsWith("en-");
}

/** An answer in another language always means a negative impression (owner decision 2026-10-27). */
export function impressionFor(languageFlag: boolean, aiImpression: "positive" | "negative"): "positive" | "negative" {
  return languageFlag ? "negative" : aiImpression;
}

/** `a***@example.com`: enough to recognise the address, not enough to reveal it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** First word of the candidate's name, for greetings ("Hello, Marina"). */
export function firstName(name: string): string {
  return String(name ?? "").trim().split(/\s+/)[0].slice(0, 40);
}

/** Keeps only the digits of what the candidate typed as the access code. */
export function normaliseCode(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}
