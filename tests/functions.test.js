const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const load = file => import(require('node:url').pathToFileURL(path.join(root, file)).href);

const crypto = () => load('supabase/functions/interviews-api/crypto.ts');
const logic = () => load('supabase/functions/interviews-api/logic.ts');
const mail = () => load('supabase/functions/interviews-api/email.ts');
const flow = () => load('supabase/functions/session/flow.ts');
const ai = () => load('supabase/functions/session/ai.ts');

const validBody = () => ({
  externalId: 'ai-1',
  candidate: { name: 'Marina Souza', email: 'Marina@Example.com' },
  jobTitle: 'Product Designer',
  company: { name: 'CoreFront', color: '#315f4a', logoUrl: 'https://example.com/logo.png' },
  questions: ['Tell us about yourself.', 'Describe a project you are proud of.', 'Why this role?'],
});

test('crypto.ts is the same file in both functions', () => {
  assert.equal(read('supabase/functions/interviews-api/crypto.ts'), read('supabase/functions/session/crypto.ts'));
});

test('randomCode is numeric, padded and free of modulo bias', async () => {
  const { randomCode } = await crypto();
  for (let i = 0; i < 200; i++) assert.match(randomCode(6), /^\d{6}$/);
  assert.equal(randomCode(6, () => 7), '000007');
  const values = [4294967295, 4294000000, 123456];
  assert.equal(randomCode(6, () => values.shift()), '123456', 'values above the unbiased limit are thrown away');
});

test('hashCode depends on the salt and timingSafeEqual compares whole strings', async () => {
  const { hashCode, timingSafeEqual, sha256Hex, randomToken } = await crypto();
  assert.equal(await hashCode('a', '123456'), await hashCode('a', '123456'));
  assert.notEqual(await hashCode('a', '123456'), await hashCode('b', '123456'));
  assert.match(await sha256Hex('x'), /^[0-9a-f]{64}$/);
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.ok(!timingSafeEqual('abc', 'abd'));
  assert.ok(!timingSafeEqual('abc', 'abcd'));
  assert.match(randomToken(32), /^[A-Za-z0-9_-]{43}$/);
});

test('create validation cleans good input', async () => {
  const { validateCreate } = await logic();
  const result = validateCreate(validBody());
  assert.ok(result.ok);
  assert.equal(result.value.candidateEmail, 'marina@example.com');
  assert.equal(result.value.questions.length, 3);
  assert.equal(result.value.brandColor, '#315f4a');
  const dirty = validBody();
  dirty.candidate.name = '  Marina\u0000\n Souza  ';
  assert.equal(validateCreate(dirty).value.candidateName, 'Marina Souza');
});

test('create validation rejects bad input with a short error code', async () => {
  const { validateCreate } = await logic();
  const cases = [
    [b => { b.externalId = ''; }, 'externalId_required'],
    [b => { b.candidate.name = ''; }, 'candidate_name_required'],
    [b => { b.candidate.email = 'not-an-email'; }, 'candidate_email_invalid'],
    [b => { b.jobTitle = ''; }, 'jobTitle_required'],
    [b => { b.company.name = ''; }, 'company_name_required'],
    [b => { b.company.color = 'green'; }, 'company_color_invalid'],
    [b => { b.company.logoUrl = 'http://example.com/logo.png'; }, 'company_logo_invalid'],
    [b => { b.questions = []; }, 'questions_invalid'],
    [b => { b.questions = ['a question', 'b question', 'c question', 'd question', 'e question', 'f question']; }, 'questions_invalid'],
    [b => { b.questions = ['ok question', 'x']; }, 'questions_invalid'],
    [b => { b.questions = 'Tell us about yourself.'; }, 'questions_invalid'],
  ];
  for (const [mutate, expected] of cases) {
    const body = validBody();
    mutate(body);
    const result = validateCreate(body);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  }
});

test('re-send rules: not started, 3 re-sends at most, one every 24 hours', async () => {
  const { canResend, resendsLeft } = await logic();
  const now = new Date('2026-10-28T12:00:00Z');
  const hoursAgo = hours => new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  assert.deepEqual(canResend({ status: 'invited', invite_count: 1, last_invite_at: hoursAgo(25) }, now), { ok: true });
  assert.equal(canResend({ status: 'invited', invite_count: 1, last_invite_at: hoursAgo(2) }, now).error, 'resend_too_soon');
  assert.equal(canResend({ status: 'invited', invite_count: 4, last_invite_at: hoursAgo(48) }, now).error, 'resend_limit');
  assert.deepEqual(canResend({ status: 'invited', invite_count: 3, last_invite_at: hoursAgo(48) }, now), { ok: true });
  assert.deepEqual(canResend({ status: 'created', invite_count: 0, last_invite_at: null }, now), { ok: true });
  for (const status of ['in_progress', 'completed', 'cancelled', 'abandoned', 'expired']) {
    assert.equal(canResend({ status, invite_count: 1, last_invite_at: hoursAgo(48) }, now).error, 'not_resendable');
  }
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(resendsLeft), [3, 3, 2, 1, 0, 0]);
});

test('maskEmail is the same in both functions and hides the address', async () => {
  const a = await logic();
  const b = await flow();
  for (const email of ['marina@example.com', 'a@b.co', 'weird']) assert.equal(a.maskEmail(email), b.maskEmail(email));
  assert.equal(a.maskEmail('marina@example.com'), 'm***@example.com');
});

test('after an answer: follow-up only for a real answer, then the next question, then done', async () => {
  const { nextStep } = await flow();
  const good = { skipped: false, onTopic: true, offensive: false };
  assert.deepEqual(nextStep({ qIndex: 0, phase: 'question' }, 3, good), { kind: 'followup' });
  assert.deepEqual(nextStep({ qIndex: 0, phase: 'followup' }, 3, good), { kind: 'question', qIndex: 1 });
  assert.deepEqual(nextStep({ qIndex: 2, phase: 'followup' }, 3, good), { kind: 'done' });
  assert.deepEqual(nextStep({ qIndex: 2, phase: 'question' }, 3, { ...good, onTopic: false }), { kind: 'done' });
  assert.deepEqual(nextStep({ qIndex: 0, phase: 'question' }, 3, { ...good, onTopic: false }), { kind: 'question', qIndex: 1 });
  assert.deepEqual(nextStep({ qIndex: 0, phase: 'question' }, 3, { ...good, offensive: true }), { kind: 'question', qIndex: 1 });
  assert.deepEqual(nextStep({ qIndex: 1, phase: 'question' }, 3, { ...good, skipped: true }), { kind: 'question', qIndex: 2 });
});

test('the 3-minute timer is checked on the server with a small allowance', async () => {
  const { secondsLeft, answerAllowed, ANSWER_SECONDS, GRACE_SECONDS } = await flow();
  const start = '2026-10-28T12:00:00.000Z';
  const at = seconds => new Date(Date.parse(start) + seconds * 1000);
  assert.equal(ANSWER_SECONDS, 180);
  assert.equal(GRACE_SECONDS, 120, 'a recording cut by the timer can still be sent for two minutes');
  assert.equal(secondsLeft(start, at(0)), 180);
  assert.equal(secondsLeft(start, at(60)), 120);
  assert.equal(secondsLeft(start, at(999)), 0);
  assert.ok(answerAllowed(start, at(179)));
  assert.ok(answerAllowed(start, at(180 + GRACE_SECONDS)));
  assert.ok(!answerAllowed(start, at(181 + GRACE_SECONDS)));
  assert.ok(!answerAllowed(null, at(1)));
});

test('an answer in another language always gives a negative impression; unknown language is not punished', async () => {
  const { isEnglish, impressionFor } = await flow();
  assert.ok(isEnglish('en') && isEnglish('EN-us') && isEnglish('') && isEnglish('und') && isEnglish(undefined));
  assert.ok(!isEnglish('pt') && !isEnglish('es'));
  assert.equal(impressionFor(true, 'positive'), 'negative');
  assert.equal(impressionFor(false, 'positive'), 'positive');
  assert.equal(impressionFor(false, 'negative'), 'negative');
});

test('access code input keeps only six digits', async () => {
  const { normaliseCode } = await flow();
  assert.equal(normaliseCode(' 123 456 '), '123456');
  assert.equal(normaliseCode('12-34-56-78'), '123456');
  assert.equal(normaliseCode(null), '');
});

test('invitation e-mail has the link and code, escapes HTML and falls back to the Witcher green', async () => {
  const { buildInvitationEmail } = await mail();
  const base = { name: 'Marina', jobTitle: 'Designer', companyName: 'CoreFront', link: 'https://x.test/interview.html#i=abc', code: '042517', expiresAt: '2026-11-04T12:00:00Z' };
  const first = buildInvitationEmail({ ...base, brandColor: '#112233' });
  assert.match(first.text, /042517/);
  assert.match(first.text, /interview\.html#i=abc/);
  assert.match(first.html, /#112233/);
  assert.match(first.text, /the AI does not decide/i);
  assert.doesNotMatch(first.text, /replaces any code/);
  const again = buildInvitationEmail({ ...base, isResend: true, brandColor: 'javascript:alert(1)' });
  assert.match(again.text, /replaces any code from an earlier e-mail/);
  assert.match(again.html, /#315f4a/, 'a bad colour never reaches the HTML');
  const evil = buildInvitationEmail({ ...base, name: '<script>alert(1)</script>' });
  assert.doesNotMatch(evil.html, /<script>/);
  assert.match(evil.subject, /Designer at CoreFront/);
});

test('the offline stub follows steering in the test "audio" and defaults otherwise', async () => {
  const { stubProvider } = await ai();
  const audio = payload => Buffer.from(JSON.stringify(payload)).toString('base64');
  const context = payload => ({ job: 'Designer', role: null, company: 'CoreFront', question: 'Q', isFollowUp: false, audioBase64: audio(payload), mimeType: 'audio/webm' });
  const plain = await stubProvider.analyseAnswer({ ...context({}), audioBase64: 'AAAA' });
  assert.equal(plain.language, 'en');
  assert.ok(plain.onTopic && !plain.offensive && plain.followUp);
  const steered = await stubProvider.analyseAnswer(context({ transcript: 'Hello', language: 'pt' }));
  assert.equal(steered.transcript, 'Hello');
  assert.equal(steered.language, 'pt');
  assert.equal((await stubProvider.analyseAnswer(context({ offensive: true }))).followUp, null);
  assert.equal((await stubProvider.analyseAnswer(context({ onTopic: false }))).followUp, null);
  assert.equal((await stubProvider.analyseAnswer({ ...context({}), isFollowUp: true })).followUp, null);
  const result = await stubProvider.evaluate({ job: 'Designer', role: null, company: 'CoreFront', lines: [{ role: 'candidate', kind: 'answer', body: 'x' }] });
  assert.equal(result.impression, 'positive');
});

test('database: browser roles get nothing, RLS is on, only service_role may call the internal functions', () => {
  const sql = read('supabase/migrations/20261028115728_core_interviews.sql');
  for (const table of ['interviews', 'interview_messages']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant all on public\\.${table} to service_role`));
  }
  for (const fn of ['witcher_code_failure\\(uuid, int, int\\)', 'witcher_abandon\\(uuid\\)', 'witcher_sweep\\(int\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`));
  }
  assert.doesNotMatch(sql, /audio_(data|blob|base64|url)|bytea/i, 'no column can hold audio');
  assert.match(sql, /grant execute on function public\.witcher_ping\(\) to anon/);
});

test('the abandon time is the same in the database sweep and in the session function', async () => {
  const sql = read('supabase/migrations/20261028115728_core_interviews.sql');
  const { ABANDON_AFTER_SECONDS } = await flow();
  assert.match(sql, new RegExp(`p_abandon_after_seconds int default ${ABANDON_AFTER_SECONDS}\\)`));
  assert.match(read('supabase/migrations/20261028115750_schedule_sweep.sql'), /cron\.schedule\('witcher-sweep', '\* \* \* \* \*'/);
});

test('functions: no JWT (own checks), test and stub modes are refused on production, audio is never stored, no content in logs', () => {
  const config = read('supabase/config.toml');
  assert.match(config, /\[functions\.interviews-api\][\s\S]*?verify_jwt = false/);
  assert.match(config, /\[functions\.session\][\s\S]*?verify_jwt = false/);
  const api = read('supabase/functions/interviews-api/index.ts');
  const session = read('supabase/functions/session/index.ts');
  for (const source of [api, session]) assert.match(source, /PRODUCTION_REF = "iwpmsfoovppqnldciric"/);
  assert.match(api, /TEST_MODE = Deno\.env\.get\("WITCHER_TEST_MODE"\) === "1" && !projectUrl\.includes\(PRODUCTION_REF\)/);
  assert.match(session, /AI_PROVIDER"\) === "stub" && !projectUrl\.includes\(PRODUCTION_REF\)/);
  assert.match(api, /x-witcher-api-key/);
  assert.match(api, /timingSafeEqual/);
  assert.doesNotMatch(session, /storage/i, 'the session function never uses Storage');
  assert.doesNotMatch(session + api, /console\.(log|info|debug)\(/);
  assert.doesNotMatch(session, /console\.error\([^)]*(transcript|audio|body|answer)/i);
  assert.doesNotMatch(session, /audio_base64|audioBase64\s*[:,]\s*audio\s*\}\s*\)\s*;?\s*[\s\S]*from\("interview/, 'audio is not written to the database');
});

test('keep-alive workflow pings both projects with public keys only', () => {
  const yml = read('.github/workflows/supabase-keepalive.yml');
  assert.match(yml, /iwpmsfoovppqnldciric\.supabase\.co/);
  assert.match(yml, /dvyeucfxwkibscooocby\.supabase\.co/);
  assert.match(yml, /rpc\/witcher_ping/);
  assert.match(yml, /permissions: \{\}/);
  assert.equal((yml.match(/sb_publishable_/g) || []).length, 2);
  assert.doesNotMatch(yml, /sb_secret_|service_role|eyJhbGci/);
});

test('greeting uses only the first word of the name', async () => {
  const { firstName } = await flow();
  assert.equal(firstName('  Marina   Souza '), 'Marina');
  assert.equal(firstName(''), '');
  assert.equal(firstName('A'.repeat(100)).length, 40);
  assert.match(read('supabase/functions/session/index.ts'), /candidateFirstName: firstName\(row\.candidate_name\)/);
});
