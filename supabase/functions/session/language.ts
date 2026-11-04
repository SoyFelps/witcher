// The language of an interview and the fixed texts the SERVER writes in it. This file is copied into each function folder
// (tests/functions.test.js checks the copies are identical). Pure: no Deno or network access, so Node can test it.
// The language of an interview is the language of the job description (decided by the owner on 2026-11-04). Pathway sends it as a
// code; a missing code means English, exactly as before this existed. The page the candidate sees has its own copy of the
// texts it shows (interview-i18n.js).

export const LANGUAGES = ["en", "pt", "es"] as const;
export type Lang = typeof LANGUAGES[number];
export const DEFAULT_LANGUAGE: Lang = "en";

/** "pt-BR" -> "pt", "ES" -> "es". null when the language is not one of the three supported ones. */
export function normalizeLanguage(value: unknown): Lang | null {
  const base = String(value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Lang) : null;
}

/** The name the AI is told to use, in English. */
export function languageName(lang: Lang): string {
  return lang === "pt" ? "Brazilian Portuguese" : lang === "es" ? "Spanish" : "English";
}

/** The name of the language in that same language, for notes written for the hiring team. */
export function nativeName(lang: Lang): string {
  return lang === "pt" ? "português" : lang === "es" ? "español" : "English";
}

/**
 * True when what the candidate spoke is the language of the interview. When the AI cannot tell the language ("und", empty) the
 * candidate is not punished. Regional variants count as the same language (pt-BR and pt-PT), and a few foreign words inside an
 * answer do not matter: the AI reports the MAIN language spoken.
 */
export function sameLanguage(expected: Lang, spoken: string | null | undefined): boolean {
  const code = String(spoken ?? "").trim().toLowerCase();
  if (code === "" || code === "und" || code === "unknown") return true;
  return code.split(/[-_]/)[0] === expected;
}

interface Texts {
  followUpFallback: string;
  closing: string;
  evaluationFailed: string;
  languageNote: string; // {language} is replaced by nativeName(expected language)
  skippedNote: string;
}

const TEXTS: Record<Lang, Texts> = {
  en: {
    followUpFallback: "Thank you. Could you tell me a bit more about that?",
    closing: "Thank you for your time. Your answers were sent to the hiring team.",
    evaluationFailed: "The evaluation could not be generated automatically. Please review the transcript.",
    languageNote: "Note: at least one answer was not given in {language} (the language of this job), which automatically sets the impression to negative.",
    skippedNote: "Note: more than 32% of the answers were skipped, which automatically sets the impression to negative.",
  },
  pt: {
    followUpFallback: "Obrigado. Você poderia me contar um pouco mais sobre isso?",
    closing: "Obrigado pelo seu tempo. Suas respostas foram enviadas à equipe de contratação.",
    evaluationFailed: "A avaliação não pôde ser gerada automaticamente. Por favor, revise a transcrição.",
    languageNote: "Nota: pelo menos uma resposta não foi dada em {language} (o idioma desta vaga), o que define automaticamente a impressão como negativa.",
    skippedNote: "Nota: mais de 32% das respostas foram puladas, o que define automaticamente a impressão como negativa.",
  },
  es: {
    followUpFallback: "Gracias. ¿Podría contarme un poco más sobre eso?",
    closing: "Gracias por su tiempo. Sus respuestas fueron enviadas al equipo de contratación.",
    evaluationFailed: "No se pudo generar la evaluación automáticamente. Por favor, revise la transcripción.",
    languageNote: "Nota: al menos una respuesta no fue dada en {language} (el idioma de esta vacante), lo que establece automáticamente la impresión como negativa.",
    skippedNote: "Nota: más del 32% de las respuestas fueron omitidas, lo que establece automáticamente la impresión como negativa.",
  },
};

export const followUpFallback = (lang: Lang): string => TEXTS[lang].followUpFallback;
export const closingText = (lang: Lang): string => TEXTS[lang].closing;
export const evaluationFailedText = (lang: Lang): string => TEXTS[lang].evaluationFailed;
export const languageNote = (lang: Lang): string => TEXTS[lang].languageNote.replace("{language}", nativeName(lang));
export const skippedNote = (lang: Lang): string => TEXTS[lang].skippedNote;
/** Every language's "could not be generated" text: an evaluation that starts with any of them can be redone. */
export const ALL_EVALUATION_FAILED_TEXTS: string[] = LANGUAGES.map((lang) => TEXTS[lang].evaluationFailed);
