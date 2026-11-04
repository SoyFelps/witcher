// Interview invitation e-mail: pure helpers with no Deno or network access, so they can be unit-tested in Node.
// E-mail clients cannot read CSS variables, so the brand colours below are written out on purpose.
// The e-mail is written in the language of the interview (the language of the job): English, Portuguese or Spanish.
import { DEFAULT_LANGUAGE, type Lang, nativeName } from "./language.ts";

export interface InvitationInput {
  name: string;
  jobTitle: string;
  companyName: string;
  brandColor?: string | null;
  link: string;
  code: string;
  expiresAt: string;
  isResend?: boolean;
  language?: Lang;
}

export interface InvitationEmail {
  subject: string;
  text: string;
  html: string;
  fromName: string;
}

const CONTROL_CHARACTERS = new RegExp(`[\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]`, "g");

function singleLine(value: unknown, max: number): string {
  return String(value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// The brand colour on the e-mail button: text that stays readable on it, and an edge that stays visible on a white page
// (a white or pale brand colour would otherwise give a button nobody can see). Same rules as accentTokens in interview-core.js.
const MAIL_INK = "#17251e";
const MAIL_PAGE = "#ffffff";

function channelLuminance(hex: string, index: number): number {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  return 0.2126 * channelLuminance(hex, 0) + 0.7152 * channelLuminance(hex, 1) + 0.0722 * channelLuminance(hex, 2);
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
function mix(a: string, b: string, ratio: number): string {
  const part = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(part(a, i) * ratio + part(b, i) * (1 - ratio)).toString(16).padStart(2, "0")).join("");
}

// edge: a subtle outline for the button (contrast 2:1); strong: for small text such as the label above the title (contrast 3:1).
function visibleOnPage(accent: string, min: number): string {
  let color = accent;
  for (let ratio = 1; contrast(color, MAIL_PAGE) < min && ratio > 0;) {
    ratio = Math.max(0, ratio - 0.05);
    color = mix(accent, MAIL_INK, ratio);
  }
  return color;
}

export function mailColors(accent: string): { accent: string; text: string; edge: string; strong: string } {
  return { accent, text: luminance(accent) > 0.4 ? MAIL_INK : "#ffffff", edge: visibleOnPage(accent, 2), strong: visibleOnPage(accent, 3) };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display name for the From header: no quotes, angle brackets or other characters that could break the header. */
export function safeDisplayName(value: string): string {
  return singleLine(value, 60).replace(/["<>@\\,;:()[\]]/g, "").trim() || "Witcher";
}

interface Copy {
  locale: string;
  htmlLang: string;
  fallbackName: string;
  fallbackJob: string;
  fallbackCompany: string;
  subject: (isResend: boolean, job: string, company: string) => string;
  hi: (name: string) => string;
  intro: (company: string, job: string) => string;
  introHtml: (company: string, job: string) => string;
  languageLine: (language: string) => string;
  startHere: string;
  accessCode: string;
  resendNote: string;
  validUntil: (date: string) => string;
  needs: string;
  automated: (company: string) => string;
  labelNew: string;
  labelResend: string;
  heading: (name: string) => string;
  codeLabel: string;
  codeLabelResend: string;
  button: string;
  validShort: (date: string) => string;
  footer: (company: string) => string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    locale: "en-US",
    htmlLang: "en",
    fallbackName: "there",
    fallbackJob: "the open role",
    fallbackCompany: "the hiring team",
    subject: (isResend, job, company) => `${isResend ? "Reminder: your" : "Your"} interview for ${job} at ${company}`,
    hi: (name) => `Hi ${name},`,
    intro: (company, job) => `${company} invites you to a short interview for ${job}. An AI assistant asks a few questions and you answer out loud. The company reviews your answers; the AI does not decide who moves forward.`,
    introHtml: (company, job) => `<strong>${company}</strong> invites you to a short interview for <strong>${job}</strong>. An AI assistant asks a few questions and you answer out loud. The company reviews your answers; the AI does not decide who moves forward.`,
    languageLine: (language) => `The interview is in ${language}: please answer in ${language}.`,
    startHere: "Start here:",
    accessCode: "Your access code:",
    resendNote: "(This code replaces any code from an earlier e-mail.)",
    validUntil: (date) => `The invitation is valid until ${date}. You will need a quiet place and a working microphone.`,
    needs: "You will need a quiet place and a working microphone.",
    automated: (company) => `This is an automated message sent by Witcher on behalf of ${company}. Please do not reply to this e-mail.`,
    labelNew: "Interview invitation",
    labelResend: "Interview reminder",
    heading: (name) => `Hi ${name}, you are invited to an interview.`,
    codeLabel: "Your access code",
    codeLabelResend: "Your access code (replaces any earlier code)",
    button: "Start your interview",
    validShort: (date) => `Valid until ${date}. `,
    footer: (company) => `Automated message sent by Witcher on behalf of ${company}. Please do not reply to this e-mail.`,
  },
  pt: {
    locale: "pt-BR",
    htmlLang: "pt-BR",
    fallbackName: "tudo bem",
    fallbackJob: "a vaga em aberto",
    fallbackCompany: "a equipe de contratação",
    subject: (isResend, job, company) => `${isResend ? "Lembrete: sua" : "Sua"} entrevista para ${job} em ${company}`,
    hi: (name) => `Olá, ${name},`,
    intro: (company, job) => `${company} convida você para uma entrevista curta para ${job}. Um assistente de IA faz algumas perguntas e você responde em voz alta. A empresa analisa as suas respostas; a IA não decide quem avança.`,
    introHtml: (company, job) => `<strong>${company}</strong> convida você para uma entrevista curta para <strong>${job}</strong>. Um assistente de IA faz algumas perguntas e você responde em voz alta. A empresa analisa as suas respostas; a IA não decide quem avança.`,
    languageLine: (language) => `A entrevista é em ${language}: responda em ${language}.`,
    startHere: "Comece aqui:",
    accessCode: "Seu código de acesso:",
    resendNote: "(Este código substitui qualquer código de um e-mail anterior.)",
    validUntil: (date) => `O convite é válido até ${date}. Você vai precisar de um lugar silencioso e de um microfone funcionando.`,
    needs: "Você vai precisar de um lugar silencioso e de um microfone funcionando.",
    automated: (company) => `Esta é uma mensagem automática enviada pelo Witcher em nome de ${company}. Por favor, não responda a este e-mail.`,
    labelNew: "Convite para entrevista",
    labelResend: "Lembrete de entrevista",
    heading: (name) => `Olá, ${name}, você foi convidado(a) para uma entrevista.`,
    codeLabel: "Seu código de acesso",
    codeLabelResend: "Seu código de acesso (substitui qualquer código anterior)",
    button: "Começar a entrevista",
    validShort: (date) => `Válido até ${date}. `,
    footer: (company) => `Mensagem automática enviada pelo Witcher em nome de ${company}. Por favor, não responda a este e-mail.`,
  },
  es: {
    locale: "es-ES",
    htmlLang: "es",
    fallbackName: "hola",
    fallbackJob: "la vacante abierta",
    fallbackCompany: "el equipo de contratación",
    subject: (isResend, job, company) => `${isResend ? "Recordatorio: su" : "Su"} entrevista para ${job} en ${company}`,
    hi: (name) => `Hola, ${name}:`,
    intro: (company, job) => `${company} le invita a una entrevista breve para ${job}. Un asistente de IA le hace algunas preguntas y usted responde en voz alta. La empresa revisa sus respuestas; la IA no decide quién avanza.`,
    introHtml: (company, job) => `<strong>${company}</strong> le invita a una entrevista breve para <strong>${job}</strong>. Un asistente de IA le hace algunas preguntas y usted responde en voz alta. La empresa revisa sus respuestas; la IA no decide quién avanza.`,
    languageLine: (language) => `La entrevista es en ${language}: responda en ${language}.`,
    startHere: "Comience aquí:",
    accessCode: "Su código de acceso:",
    resendNote: "(Este código reemplaza cualquier código de un correo anterior.)",
    validUntil: (date) => `La invitación es válida hasta el ${date}. Necesitará un lugar tranquilo y un micrófono que funcione.`,
    needs: "Necesitará un lugar tranquilo y un micrófono que funcione.",
    automated: (company) => `Este es un mensaje automático enviado por Witcher en nombre de ${company}. Por favor, no responda a este correo.`,
    labelNew: "Invitación a entrevista",
    labelResend: "Recordatorio de entrevista",
    heading: (name) => `Hola, ${name}, está invitado(a) a una entrevista.`,
    codeLabel: "Su código de acceso",
    codeLabelResend: "Su código de acceso (reemplaza cualquier código anterior)",
    button: "Comenzar la entrevista",
    validShort: (date) => `Válido hasta el ${date}. `,
    footer: (company) => `Mensaje automático enviado por Witcher en nombre de ${company}. Por favor, no responda a este correo.`,
  },
};

function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function buildInvitationEmail(input: InvitationInput): InvitationEmail {
  const lang: Lang = input.language ?? DEFAULT_LANGUAGE;
  const c = COPY[lang];
  const languageName = nativeName(lang);
  const name = singleLine(input.name, 120) || c.fallbackName;
  const job = singleLine(input.jobTitle, 120) || c.fallbackJob;
  const company = singleLine(input.companyName, 80) || c.fallbackCompany;
  const colors = mailColors(/^#[0-9a-fA-F]{6}$/.test(input.brandColor || "") ? String(input.brandColor) : "#315f4a");
  const accent = colors.accent;
  const until = formatDate(input.expiresAt, c.locale);

  const subject = singleLine(c.subject(Boolean(input.isResend), job, company), 200);
  const text = [
    c.hi(name),
    "",
    c.intro(company, job),
    c.languageLine(languageName),
    "",
    `${c.startHere} ${input.link}`,
    `${c.accessCode} ${input.code}`,
    ...(input.isResend ? [c.resendNote] : []),
    "",
    until ? c.validUntil(until) : c.needs,
    "",
    c.automated(company),
  ].join("\n");

  const n = escapeHtml(name);
  const j = escapeHtml(job);
  const co = escapeHtml(company);
  const link = escapeHtml(input.link);
  const code = escapeHtml(input.code);
  const html = `<!doctype html>
<html lang="${c.htmlLang}">
  <body style="margin:0;padding:0;background:#f8f8f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17251e;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e9e4;border-radius:12px;">
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${colors.strong};font-weight:700;">${input.isResend ? c.labelResend : c.labelNew}</p>
                <h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;color:#17251e;">${c.heading(n)}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#34463a;">${c.introHtml(co, j)}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#34463a;">${escapeHtml(c.languageLine(languageName))}</p>
                <p style="margin:0 0 8px;font-size:13px;color:#748178;">${input.isResend ? c.codeLabelResend : c.codeLabel}</p>
                <p style="margin:0 0 24px;font-size:30px;letter-spacing:.3em;font-weight:700;color:#17251e;">${code}</p>
                <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;padding:12px 22px;border:1px solid ${colors.edge};border-radius:8px;background:${accent};color:${colors.text};font-size:15px;font-weight:600;text-decoration:none;">${c.button}</a></p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#748178;">${escapeHtml(until ? c.validShort(until) : "")}${c.needs}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #edf1ed;font-size:12px;line-height:1.5;color:#748178;">
                ${c.footer(co)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html, fromName: safeDisplayName(`${company} via Witcher`) };
}
