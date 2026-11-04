// Pure rules of the candidate interview (state machine, timer, impression). No Deno or network access: tested in Node.
import { type Lang, languageNote, sameLanguage, skippedNote } from "./language.ts";

export const ANSWER_SECONDS = 180; // 3 minutes per answer (owner decision)
export const GRACE_SECONDS = 120; // after the 3 minutes, a recording the timer cut short can still be listened to and sent for this long
export const ABANDON_AFTER_SECONDS = 90; // no sign of life for this long = the candidate left (also in witcher_sweep)
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_LOCK_SECONDS = 15 * 60;
export const SESSION_HOURS = 3;
/** The consent text differs per language and since 2026-11-04 it says in which language to answer, so the version names the language too. */
export const consentVersionFor = (lang: Lang): string => `2026-11-04-v2-${lang}`;
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

/** True when what the candidate spoke is the language of the interview (see language.ts). When the AI cannot tell, the candidate is not punished. */
export const isExpectedLanguage = sameLanguage;
/** The old English-only check, kept for the tests and for interviews that carry no language. */
export const isEnglish = (language: string | null | undefined): boolean => sameLanguage("en", language);

/** More than this share of the candidate's answers skipped always means a negative impression (owner decision 2026-11-02). */
export const SKIP_LIMIT = 0.32;

/** Share of the candidate's answers that were skipped (a skipped answer has no text; "[No speech detected]" is text, not a skip). */
export function skippedShare(lines: { role: string; body: string | null }[]): number {
  const answers = lines.filter((line) => line.role === "candidate");
  if (answers.length === 0) return 0;
  return answers.filter((line) => !line.body).length / answers.length;
}

export function tooManySkipped(lines: { role: string; body: string | null }[]): boolean {
  return skippedShare(lines) > SKIP_LIMIT;
}

/** An answer in another language than the one of the job (owner decision 2026-10-27, widened on 2026-11-04 from "not English") or too many skipped answers (2026-11-02) always mean a negative impression. */
export function impressionFor(languageFlag: boolean, aiImpression: "positive" | "mixed" | "negative" | null, skippedTooMuch = false): "positive" | "mixed" | "negative" | null {
  return languageFlag || skippedTooMuch ? "negative" : aiImpression; // null = the AI could not evaluate: no badge, never a made-up negative
}

// The notes in English (the language of every interview before 2026-11-04); the other languages come from language.ts.
export const LANGUAGE_NOTE = languageNote("en");
export const SKIPPED_NOTE = skippedNote("en");

/**
 * The evaluation text for the hiring team. When a fixed rule (language, skipped answers) forced a negative impression, the
 * reason is added in plain words, so nobody has to guess why an evaluation of ordinary answers carries a negative badge.
 */
export function withLanguageNote(evaluation: string, languageFlag: boolean, skippedTooMuch = false, lang: Lang = "en"): string {
  const text = String(evaluation ?? "").trim().slice(0, 5600); // leaves room for both notes inside the 6000 characters of the column
  const notes = [skippedTooMuch ? skippedNote(lang) : "", languageFlag ? languageNote(lang) : ""].filter(Boolean);
  return notes.length ? text + "\n\n" + notes.join("\n\n") : text;
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
