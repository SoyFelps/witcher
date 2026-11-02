const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const load = file => import(require('node:url').pathToFileURL(path.join(root, file)).href);
const webhook = () => load('supabase/functions/deliver/webhook.ts');
const evaluate = () => load('supabase/functions/session/evaluate.ts');

const row = (extra = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', external_id: 'pathway-applicant-7', status: 'completed', notify_event: 'completed',
  impression: 'positive', evaluation: 'Solid answers.', completed_at: '2026-10-28T12:00:00Z', abandoned_at: null, language_flag: false, ...extra,
});

test('the files shared by the session and interviews-api functions are identical copies', () => {
  for (const file of ['ai.ts', 'gemini.ts', 'flow.ts', 'evaluate.ts', 'crypto.ts']) {
    assert.equal(read(`supabase/functions/interviews-api/${file}`), read(`supabase/functions/session/${file}`), file);
  }
});

test('the signature is an HMAC-SHA256 of "<timestamp>.<body>" that Pathway can recompute', async () => {
  const { signBody } = await webhook();
  const body = JSON.stringify({ hello: 'world' });
  const expected = 'v1=' + crypto.createHmac('sha256', 'shared-secret').update('1790000000.' + body).digest('hex');
  assert.equal(await signBody('shared-secret', 1790000000, body), expected);
  assert.notEqual(await signBody('other-secret', 1790000000, body), expected);
  assert.notEqual(await signBody('shared-secret', 1790000001, body), expected, 'the timestamp is part of what is signed');
  assert.notEqual(await signBody('shared-secret', 1790000000, body + ' '), expected);
});

test('the payload carries ids, state and impression only: no name, e-mail, transcript or evaluation text', async () => {
  const { buildEventPayload } = await webhook();
  const payload = buildEventPayload(row({ candidate_name: 'Marina', candidate_email: 'm@example.com' }), new Date('2026-10-28T12:01:00Z'));
  const text = JSON.stringify(payload);
  assert.equal(payload.event, 'completed');
  assert.equal(payload.interview.externalId, 'pathway-applicant-7');
  assert.equal(payload.interview.impression, 'positive');
  assert.equal(payload.interview.evaluationReady, true);
  assert.ok(!/Marina|example\.com|Solid answers/.test(text));
});

test('evaluationReady is false when the AI wrote no evaluation or no impression', async () => {
  const { buildEventPayload } = await webhook();
  assert.equal(buildEventPayload(row({ impression: null }), new Date()).interview.evaluationReady, false);
  assert.equal(buildEventPayload(row({ evaluation: null }), new Date()).interview.evaluationReady, false);
  assert.equal(buildEventPayload(row({ notify_event: 'abandoned', status: 'abandoned', impression: null, evaluation: null }), new Date()).event, 'abandoned');
});

test('retry delays grow and stop after the last attempt', async () => {
  const { retryDelayMinutes, MAX_ATTEMPTS } = await webhook();
  assert.equal(retryDelayMinutes(1), 1);
  assert.equal(retryDelayMinutes(2), 2);
  assert.equal(retryDelayMinutes(5), 60);
  assert.equal(retryDelayMinutes(7), 720);
  assert.equal(retryDelayMinutes(MAX_ATTEMPTS), null);
  assert.equal(retryDelayMinutes(MAX_ATTEMPTS + 3), null);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) assert.ok(retryDelayMinutes(attempt) >= retryDelayMinutes(Math.max(1, attempt - 1)));
});

test('the deliver function sends only what the headers promise and never logs bodies', () => {
  const source = read('supabase/functions/deliver/index.ts');
  assert.ok(source.includes('x-witcher-signature') && source.includes('x-witcher-timestamp'));
  assert.ok(source.includes('webhook_not_configured'), 'without the address and the secret it does nothing');
  assert.ok(!/console\.(log|error)\([^)]*(body|WEBHOOK_SECRET)/.test(source));
});

test('final evaluation: a working AI gives text and impression; a broken one gives no impression', async () => {
  const { buildFinalEvaluation } = await evaluate();
  const context = { job: 'Designer', role: null, company: 'Acme', lines: [] };
  const good = { evaluate: async () => ({ evaluation: 'Clear and concrete.', impression: 'positive' }) };
  const result = await buildFinalEvaluation(good, context, false);
  assert.deepEqual([result.evaluation, result.impression, result.aiFailed], ['Clear and concrete.', 'positive', false]);
  const broken = { evaluate: async () => { throw new Error('gemini_http_503'); } };
  const failed = await buildFinalEvaluation(broken, context, false);
  assert.equal(failed.impression, null, 'an outage never makes up a negative impression');
  assert.equal(failed.aiFailed, true);
  assert.equal((await buildFinalEvaluation(null, context, false)).aiFailed, true);
});

test('final evaluation: another language forces negative and explains why', async () => {
  const { buildFinalEvaluation } = await evaluate();
  const { LANGUAGE_NOTE } = await load('supabase/functions/session/flow.ts');
  const good = { evaluate: async () => ({ evaluation: 'Clear and concrete.', impression: 'positive' }) };
  const result = await buildFinalEvaluation(good, { job: 'x', role: null, company: 'y', lines: [] }, true);
  assert.equal(result.impression, 'negative');
  assert.ok(result.evaluation.endsWith(LANGUAGE_NOTE));
});

test('an evaluation can be redone only when the AI never produced one', async () => {
  const { canReevaluate, EVALUATION_FAILED_TEXT } = await evaluate();
  assert.equal(canReevaluate({ status: 'completed', evaluation: null, impression: null }), true);
  assert.equal(canReevaluate({ status: 'completed', evaluation: EVALUATION_FAILED_TEXT, impression: null }), true);
  assert.equal(canReevaluate({ status: 'completed', evaluation: EVALUATION_FAILED_TEXT + '\n\nNote', impression: 'negative' }), true);
  assert.equal(canReevaluate({ status: 'completed', evaluation: 'Good answers.', impression: null }), true);
  assert.equal(canReevaluate({ status: 'completed', evaluation: 'Good answers.', impression: 'negative' }), false, 'a real evaluation is never replaced');
  assert.equal(canReevaluate({ status: 'abandoned', evaluation: null, impression: null }), false);
  assert.equal(canReevaluate({ status: 'in_progress', evaluation: null, impression: null }), false);
});

test('interviews-api knows reevaluate and keeps the lease so two runs never overlap', () => {
  const source = read('supabase/functions/interviews-api/index.ts');
  assert.ok(source.includes('case "reevaluate"'));
  assert.ok(source.includes('evaluating_until'));
  assert.ok(source.includes('not_reevaluable'));
});

test('the webhook migration is additive, keeps the new table closed to browsers and schedules the delivery', () => {
  const sql = read('supabase/migrations/20261028180000_webhook_delivery.sql');
  assert.ok(sql.includes('enable row level security'));
  assert.ok(sql.includes('revoke all on public.witcher_settings from public, anon, authenticated'));
  assert.ok(sql.includes('grant all on public.witcher_settings to service_role'));
  assert.ok(sql.includes("cron.schedule('witcher-deliver'"));
  assert.ok(sql.includes('revoke all on function public.witcher_kick_delivery() from public, anon, authenticated'));
  assert.ok(!/drop table|delete from|truncate/i.test(sql));
  assert.ok(!sql.includes('functions/v1'), 'the project address is set per project with SQL, never written in a migration');
});

test('the function settings keep the deliver function open to the database job (no JWT)', () => {
  assert.match(read('supabase/config.toml'), /\[functions\.deliver\][^[]*verify_jwt = false/);
});

test('get tells the client whether a re-evaluation is running, so it can show "being written" and offer the button again only after a real failure', () => {
  const source = read('supabase/functions/interviews-api/index.ts');
  assert.ok(source.includes('evaluating_until,q_index,phase'), 'the lease column is read');
  assert.ok(source.includes('evaluating: Boolean(row.evaluating_until) && Date.parse(row.evaluating_until) > Date.now()'));
  assert.ok(source.includes('{ evaluating_until: null }'), 'the lease is released when the AI fails again');
});

test('get tells where a candidate is, or was when they left: question number, question or follow-up, and the question text', () => {
  const source = read('supabase/functions/interviews-api/index.ts');
  assert.ok(source.includes('evaluating_until,q_index,phase,questions";'), 'the questions copy is read');
  assert.ok(source.includes('row.status === "abandoned" || row.status === "in_progress"'));
  assert.ok(source.includes('questionNumber: Number(row.q_index) + 1') && source.includes('totalQuestions: questions.length'));
  assert.ok(source.includes('questionText: row.phase === "question" ? String(questions[row.q_index] ?? "") : null'), 'a follow-up has no saved text, so none is sent');
});

test('every interview is erased one year after it was created, with its transcript (retention rule of 2026-11-01)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261101130000_purge_after_one_year.sql'), 'utf8');
  assert.ok(sql.includes("delete from public.interviews where created_at < now() - interval '1 year'"));
  assert.ok(sql.includes("cron.schedule('witcher-purge'") && sql.includes('revoke all on function public.witcher_purge_old()'));
  const core = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261028115728_core_interviews.sql'), 'utf8');
  assert.ok(core.includes('references public.interviews (id) on delete cascade'), 'the transcript goes with the interview');
});

test('final evaluation: too many skipped answers force negative even when the AI says positive or fails', async () => {
  const { buildFinalEvaluation } = await evaluate();
  const { SKIPPED_NOTE } = await load('supabase/functions/session/flow.ts');
  const lines = [{ role: 'ai', kind: 'question', body: 'Q1' }, { role: 'candidate', kind: 'answer', body: 'A strong answer with details.' }, { role: 'ai', kind: 'question', body: 'Q2' }, { role: 'candidate', kind: 'answer', body: null }];
  const context = { job: 'Cook', role: null, company: 'Acme', lines };
  const good = { evaluate: async () => ({ evaluation: 'Excellent first answer.', impression: 'positive' }) };
  const result = await buildFinalEvaluation(good, context, false);
  assert.equal(result.impression, 'negative');
  assert.ok(result.evaluation.endsWith(SKIPPED_NOTE));
  const broken = { evaluate: async () => { throw new Error('gemini_http_503'); } };
  assert.equal((await buildFinalEvaluation(broken, context, false)).impression, 'negative', 'a fixed rule does not depend on the AI');
  const fine = { ...context, lines: [...lines.slice(0, 2), { role: 'ai', kind: 'question', body: 'Q2' }, { role: 'candidate', kind: 'answer', body: 'Another good answer.' }] };
  assert.equal((await buildFinalEvaluation(good, fine, false)).impression, 'positive', 'nothing skipped: the AI decides');
});
