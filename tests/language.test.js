const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const load = file => import(require('node:url').pathToFileURL(path.join(root, file)).href);
const language = () => load('supabase/functions/session/language.ts');
const flow = () => load('supabase/functions/session/flow.ts');
const evaluate = () => load('supabase/functions/session/evaluate.ts');
const gemini = () => load('supabase/functions/session/gemini.ts');
const logic = () => load('supabase/functions/interviews-api/logic.ts');
const mail = () => load('supabase/functions/interviews-api/email.ts');

test('the shared language files are the same in both functions', () => {
  for (const file of ['language.ts', 'flow.ts', 'evaluate.ts', 'ai.ts', 'gemini.ts', 'crypto.ts']) {
    assert.equal(read(`supabase/functions/interviews-api/${file}`), read(`supabase/functions/session/${file}`), `${file} must be identical`);
  }
});

test('three languages are supported and regional variants collapse to the base language', async () => {
  const { LANGUAGES, normalizeLanguage, languageName, nativeName } = await language();
  assert.deepEqual([...LANGUAGES], ['en', 'pt', 'es']);
  assert.equal(normalizeLanguage('pt-BR'), 'pt');
  assert.equal(normalizeLanguage('PT_pt'), 'pt');
  assert.equal(normalizeLanguage(' ES '), 'es');
  assert.equal(normalizeLanguage('en-GB'), 'en');
  assert.equal(normalizeLanguage('fr'), null);
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(undefined), null);
  assert.equal(languageName('pt'), 'Brazilian Portuguese');
  assert.equal(nativeName('es'), 'español');
});

test('the impression rule compares with the language of the job, not with English', async () => {
  const { sameLanguage } = await language();
  // Portuguese job
  assert.equal(sameLanguage('pt', 'pt'), true);
  assert.equal(sameLanguage('pt', 'pt-BR'), true);
  assert.equal(sameLanguage('pt', 'PT-pt'), true);
  assert.equal(sameLanguage('pt', 'en'), false, 'English on a Portuguese job is another language');
  assert.equal(sameLanguage('pt', 'es'), false);
  // English job: the old rule
  assert.equal(sameLanguage('en', 'en-US'), true);
  assert.equal(sameLanguage('en', 'pt'), false);
  // Spanish job
  assert.equal(sameLanguage('es', 'es'), true);
  assert.equal(sameLanguage('es', 'pt'), false);
  // the AI could not tell: nobody is punished
  for (const unknown of ['', 'und', 'UND', 'unknown', null, undefined]) assert.equal(sameLanguage('pt', unknown), true);
});

test('the notes of the evaluation are written in the language of the job and name that language', async () => {
  const { withLanguageNote } = await flow();
  const { languageNote, skippedNote } = await language();
  assert.match(languageNote('en'), /not given in English \(the language of this job\)/);
  assert.match(languageNote('pt'), /não foi dada em português \(o idioma desta vaga\)/);
  assert.match(languageNote('es'), /no fue dada en español \(el idioma de esta vacante\)/);
  assert.match(skippedNote('pt'), /32%/);
  assert.match(skippedNote('es'), /32%/);
  assert.equal(withLanguageNote('Respostas sólidas.', true, false, 'pt'), 'Respostas sólidas.\n\n' + languageNote('pt'));
  assert.equal(withLanguageNote('Fine.', true, true, 'es'), 'Fine.\n\n' + skippedNote('es') + '\n\n' + languageNote('es'));
  assert.equal(withLanguageNote('Fine.', true), 'Fine.\n\n' + languageNote('en'), 'English is still the default');
  assert.ok(withLanguageNote('x'.repeat(9000), true, true, 'pt').length <= 6000);
});

test('the consent version names the language, so a text in one language is never recorded as another', async () => {
  const { consentVersionFor } = await flow();
  assert.equal(consentVersionFor('en'), '2026-11-04-v2-en');
  assert.equal(consentVersionFor('pt'), '2026-11-04-v2-pt');
  assert.notEqual(consentVersionFor('pt'), consentVersionFor('es'));
});

test('an evaluation that could not be written is redone whatever language its text was in', async () => {
  const { canReevaluate, buildFinalEvaluation } = await evaluate();
  const { evaluationFailedText, LANGUAGES } = await language();
  for (const lang of LANGUAGES) {
    assert.equal(canReevaluate({ status: 'completed', evaluation: evaluationFailedText(lang), impression: null }), true, lang);
    const result = await buildFinalEvaluation(null, { job: 'x', role: null, company: 'y', lines: [], language: lang }, false);
    assert.equal(result.aiFailed, true);
    assert.equal(result.evaluation, evaluationFailedText(lang), 'the failure text is in the language of the job');
  }
  assert.equal(canReevaluate({ status: 'completed', evaluation: 'A real evaluation.', impression: 'positive' }), false);
});

test('the AI is told to talk in the language of the job and to judge in it', async () => {
  const { buildAnswerRequest, buildEvaluationRequest } = await gemini();
  const context = { job: 'Cook', role: null, company: 'Le Lyon', question: 'Como você mantém a segurança alimentar?', isFollowUp: false, audioBase64: 'AAAA', mimeType: 'audio/webm' };
  const text = request => request.systemInstruction.parts[0].text;
  const pt = text(buildAnswerRequest({ ...context, language: 'pt' }));
  assert.match(pt, /follow-up question in Brazilian Portuguese/);
  assert.match(pt, /the follow-up is always in Brazilian Portuguese, whatever language the candidate speaks/);
  assert.match(pt, /expected to answer in Brazilian Portuguese/);
  assert.match(pt, /report that language in the language field/);
  assert.equal(/always in English/.test(pt), false, 'no leftover English-only rule');
  assert.match(pt, /Never invent anything\. In case of silence, do not invent anything\./, 'the silence guard stays in every language');
  assert.match(text(buildAnswerRequest({ ...context, language: 'es' })), /follow-up question in Spanish/);
  assert.match(text(buildAnswerRequest(context)), /follow-up question in English/, 'a context without a language is English, as before');

  const lines = [{ role: 'ai', kind: 'question', body: 'Pergunta?' }, { role: 'candidate', kind: 'answer', body: 'Resposta concreta.' }];
  const evalPt = text(buildEvaluationRequest({ job: 'Cook', role: null, company: 'Le Lyon', lines, language: 'pt' }));
  assert.match(evalPt, /evaluation: one paragraph in Brazilian Portuguese/);
  assert.match(evalPt, /how well the candidate speaks Brazilian Portuguese/);
  assert.equal(/paragraph in English/.test(evalPt), false);
  assert.match(text(buildEvaluationRequest({ job: 'Cook', role: null, company: 'x', lines })), /paragraph in English/);
});

test('the create call carries the language of the job: missing means English, an unsupported one is refused', async () => {
  const { validateCreate } = await logic();
  const body = { externalId: 'x1', candidate: { name: 'Ana', email: 'ana@example.com' }, jobTitle: 'Cook', company: { name: 'Le Lyon' }, questions: ['Primeira pergunta?'] };
  assert.equal(validateCreate(body).value.language, 'en');
  assert.equal(validateCreate({ ...body, language: 'pt-BR' }).value.language, 'pt');
  assert.equal(validateCreate({ ...body, language: 'ES' }).value.language, 'es');
  assert.deepEqual(validateCreate({ ...body, language: 'fr' }), { ok: false, error: 'language_invalid' });
  assert.deepEqual(validateCreate({ ...body, language: 'xx' }), { ok: false, error: 'language_invalid' });
  assert.equal(validateCreate({ ...body, language: null }).value.language, 'en');
});

test('the invitation e-mail is written in the language of the job and says which language to answer in', async () => {
  const { buildInvitationEmail } = await mail();
  const base = { name: 'Ana', jobTitle: 'Cook', companyName: 'Le Lyon', link: 'https://x.test/i#i=1', code: '123456', expiresAt: '2026-11-11T12:00:00Z' };
  const en = buildInvitationEmail(base);
  assert.match(en.subject, /Your interview for Cook at Le Lyon/);
  assert.match(en.text, /The interview is in English: please answer in English\./);
  assert.match(en.html, /<html lang="en">/);
  const pt = buildInvitationEmail({ ...base, language: 'pt' });
  assert.match(pt.subject, /Sua entrevista para Cook em Le Lyon/);
  assert.match(pt.text, /A entrevista é em português: responda em português\./);
  assert.match(pt.text, /Seu código de acesso: 123456/);
  assert.match(pt.text, /novembro/);
  assert.match(pt.html, /<html lang="pt-BR">/);
  assert.match(pt.html, /Começar a entrevista/);
  const es = buildInvitationEmail({ ...base, language: 'es', isResend: true });
  assert.match(es.subject, /Recordatorio: su entrevista para Cook en Le Lyon/);
  assert.match(es.text, /La entrevista es en español: responda en español\./);
  assert.match(es.text, /Este código reemplaza/);
  assert.match(es.html, /<html lang="es">/);
  for (const mailBody of [en, pt, es]) assert.equal(/undefined|NaN/.test(mailBody.text + mailBody.html), false);
});

test('the session function uses the language of the interview everywhere it talks or judges', () => {
  const src = read('supabase/functions/session/index.ts');
  assert.ok(src.includes('const langOf = (row: Row): Lang => normalizeLanguage(row.language) ?? DEFAULT_LANGUAGE;'));
  assert.ok(src.includes('last_seen_at,session_expires_at,language_flag,language";'));
  assert.ok(src.includes('language: langOf(row), branding: branding(row)'), 'open tells the page the language before the code is typed');
  assert.ok(src.includes('consentVersion: consentVersionFor(langOf(row))'));
  assert.ok(src.includes('body.version !== consentVersionFor(langOf(row))'));
  assert.ok(src.includes('!sameLanguage(langOf(row), analysis.language)'), 'the impression rule compares with the language of the job');
  assert.ok(src.includes('followUpFallback(langOf(row))') && src.includes('closingText(langOf(row))'));
  assert.ok(src.includes('language: langOf(row),\n      });') || src.includes('language: langOf(row) },'), 'the AI receives the language');
  assert.equal(/isEnglish/.test(src), false, 'the English-only check is gone from the session function');
});

test('the API stores and reports the language of each interview', () => {
  const src = read('supabase/functions/interviews-api/index.ts');
  assert.ok(src.includes('language: v.language,'));
  assert.ok(src.includes('language_flag,language,evaluation'));
  assert.ok(src.includes('language: normalizeLanguage(row.language) ?? DEFAULT_LANGUAGE,'));
  const migration = read('supabase/migrations/20261104200000_interview_language.sql');
  assert.match(migration, /add column if not exists language text not null default 'en'/);
  assert.match(migration, /check \(language in \('en', 'pt', 'es'\)\)/);
});
