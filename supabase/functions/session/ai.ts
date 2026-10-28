// The AI behind the interview. Phase 2 ships only a STUB (fixed, offline answers) so the whole flow can be tested;
// the Gemini provider replaces it in Phase 4. The audio is only ever held in memory for the duration of one call.

export interface AnswerContext {
  job: string;
  role: string | null;
  company: string;
  question: string;
  isFollowUp: boolean;
  audioBase64: string;
  mimeType: string;
}

export interface AnswerAnalysis {
  transcript: string;
  onTopic: boolean;
  offensive: boolean;
  language: string; // ISO 639-1, e.g. "en"
  followUp: string | null; // text of the follow-up question, when the AI wants to ask one
}

export interface TranscriptLine { role: "ai" | "candidate"; kind: string; body: string | null }

export interface EvaluationContext {
  job: string;
  role: string | null;
  company: string;
  lines: TranscriptLine[];
}

export interface Evaluation { evaluation: string; impression: "positive" | "negative" }

export interface AiProvider {
  analyseAnswer(context: AnswerContext): Promise<AnswerAnalysis>;
  evaluate(context: EvaluationContext): Promise<Evaluation>;
}

function decodeTestPayload(audioBase64: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0))));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Offline stand-in. If the "audio" is really a small JSON document (what the tests send) its fields steer the
 * result: {"transcript": "...", "onTopic": false, "offensive": true, "language": "pt"}. Anything else gets a default.
 */
export const stubProvider: AiProvider = {
  analyseAnswer(context) {
    const steer = decodeTestPayload(context.audioBase64) ?? {};
    const onTopic = steer.onTopic !== false;
    const offensive = steer.offensive === true;
    const language = typeof steer.language === "string" ? steer.language : "en";
    const transcript = typeof steer.transcript === "string" ? steer.transcript.slice(0, 4000) : "[stub transcript]";
    const followUp = context.isFollowUp || !onTopic || offensive
      ? null
      : "Thank you. Could you walk me through a concrete example of that?";
    return Promise.resolve({ transcript, onTopic, offensive, language, followUp });
  },
  evaluate(context) {
    const answered = context.lines.filter((line) => line.role === "candidate" && line.body).length;
    return Promise.resolve({
      evaluation: `[stub evaluation] The candidate gave ${answered} answer(s) for ${context.job} at ${context.company}.`,
      impression: "positive",
    });
  },
};
