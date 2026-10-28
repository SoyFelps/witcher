// The final evaluation of an interview, shared by the `session` function (written right after the last answer) and the
// `interviews-api` function (the client asks to redo an evaluation the AI could not write). This file is copied into
// each function folder; tests/functions.test.js checks the copies are identical. No Deno or network access of its own.
import type { AiProvider, TranscriptLine } from "./ai.ts";
import { impressionFor, withLanguageNote } from "./flow.ts";

export const EVALUATION_FAILED_TEXT = "The evaluation could not be generated automatically. Please review the transcript.";

export interface FinalEvaluation {
  evaluation: string; // already carries the language note when it applies
  impression: "positive" | "negative" | null; // null when the AI could not evaluate: an outage must not hurt the candidate
  aiFailed: boolean;
}

export async function buildFinalEvaluation(
  provider: AiProvider | null,
  context: { job: string; role: string | null; company: string; lines: TranscriptLine[] },
  languageFlag: boolean,
): Promise<FinalEvaluation> {
  let evaluation = EVALUATION_FAILED_TEXT;
  let aiImpression: "positive" | "negative" | null = null;
  let aiFailed = true;
  if (provider) {
    try {
      const result = await provider.evaluate(context);
      evaluation = result.evaluation.slice(0, 6000);
      aiImpression = result.impression;
      aiFailed = false;
    } catch (error) {
      console.error("AI evaluation failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
  return { evaluation: withLanguageNote(evaluation, languageFlag), impression: impressionFor(languageFlag, aiImpression), aiFailed };
}

/**
 * An evaluation may be redone only when the AI never produced one (nothing saved, the "could not be generated" text,
 * or no impression). A real evaluation is never replaced, so nobody can ask again until the result looks better.
 */
export function canReevaluate(row: { status: string; evaluation: string | null; impression: string | null }): boolean {
  if (row.status !== "completed") return false;
  if (!row.evaluation) return true;
  return row.evaluation.startsWith(EVALUATION_FAILED_TEXT) || row.impression === null;
}
