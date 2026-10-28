const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const Core = require('../interview-core.js');

test('the link id is read from the hash and must be a UUID', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(Core.parseLinkId(`#i=${id}`), id);
  assert.equal(Core.parseLinkId(`#x=1&i=${id.toUpperCase()}`), id);
  assert.equal(Core.parseLinkId('#i=not-a-uuid'), null);
  assert.equal(Core.parseLinkId('#i=%E0%A4%A'), null);
  assert.equal(Core.parseLinkId(''), null);
  assert.equal(Core.parseLinkId(undefined), null);
});

test('clock shows minutes and seconds and never goes below zero', () => {
  assert.equal(Core.formatClock(180), '3:00');
  assert.equal(Core.formatClock(125), '2:05');
  assert.equal(Core.formatClock(9), '0:09');
  assert.equal(Core.formatClock(-4), '0:00');
  assert.equal(Core.formatClock('x'), '0:00');
});

test('timer: seconds left from a deadline, with ok / warn / over tones', () => {
  assert.equal(Core.secondsLeftFrom(10000, 0), 10);
  assert.equal(Core.secondsLeftFrom(10001, 0), 11, 'rounds up so the clock never shows 0 early');
  assert.equal(Core.secondsLeftFrom(0, 5000), 0);
  assert.equal(Core.secondsLeftFrom(1e9, 0), 180, 'never above the 3-minute limit');
  assert.deepEqual([180, 31, 30, 1, 0].map(Core.timerTone), ['ok', 'ok', 'warn', 'warn', 'over']);
});

test('text on a brand colour stays readable and bad colours are ignored', () => {
  assert.equal(Core.contrastText('#315f4a'), '#ffffff');
  assert.equal(Core.contrastText('#d2f37a'), '#17251e');
  assert.equal(Core.contrastText('#ffffff'), '#17251e');
  assert.equal(Core.contrastText('javascript:alert(1)'), '#ffffff');
  assert.ok(Core.isValidColor('#aBc123'));
  assert.ok(!Core.isValidColor('red') && !Core.isValidColor('#fff') && !Core.isValidColor(null));
});

test('recording format: first supported one in order of preference', () => {
  assert.equal(Core.pickMimeType(() => true), 'audio/webm;codecs=opus');
  assert.equal(Core.pickMimeType(type => type === 'audio/mp4'), 'audio/mp4', 'Safari');
  assert.equal(Core.pickMimeType(() => false), '');
  assert.equal(Core.pickMimeType(() => { throw new Error('boom'); }), '');
});

test('screens that end the flow have a clear title and text for every state', () => {
  for (const state of ['cancelled', 'expired', 'completed', 'abandoned', 'in_progress', 'unavailable', 'created', 'something-else']) {
    const screen = Core.stateScreen(state);
    assert.ok(screen.title.length > 5 && screen.text.length > 20, state);
  }
  assert.match(Core.stateScreen('abandoned').text, /cannot be resumed/);
  assert.equal(Core.stateScreen('nope').title, Core.stateScreen('unavailable').title);
});

test('error messages are friendly and never expose codes or secrets', () => {
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 4 }), /4 attempts left/);
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 1 }), /1 attempt left/);
  assert.match(Core.errorText('locked', { retryAt: new Date(Date.now() + 14 * 60000 + 1000).toISOString() }), /about 15 minutes/);
  assert.match(Core.errorText('time_over'), /skip/i);
  assert.match(Core.errorText('network'), /connection/);
  assert.match(Core.errorText('whatever'), /Something went wrong/);
  assert.equal(Core.cleanCode(' 12-34 56 789'), '123456');
});

test('page colours: every tint is a variation of the company colour and stays readable', () => {
  for (const color of ['#3556c8', '#d2f37a', '#c2410c', '#ffffff', '#000000', '#315f4a', '#ffd400']) {
    const tokens = Core.accentTokens(color);
    assert.equal(tokens.accent, color);
    assert.match(tokens.soft + tokens.mid + tokens.line + tokens.ink, /^(#[0-9a-f]{6}){4}$/);
    assert.ok(Core.contrastRatio(tokens.ink, tokens.soft) >= 4.5, color + ': ink on the soft tint');
    assert.ok(Core.contrastRatio(tokens.onAccent, tokens.accent) >= 4.5, color + ': text on the brand colour');
  }
  assert.equal(Core.accentTokens('green'), null);
  assert.equal(Core.accentTokens(null), null);
  assert.equal(Core.mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(Core.TEST_MAX_SECONDS, 60);
});

test('a recording with no voice is recognised and never sent', () => {
  assert.equal(Core.VOICE_MIN_LEVEL, 0.06);
  assert.ok(Core.hasVoice(0.4) && Core.hasVoice(0.06));
  assert.ok(!Core.hasVoice(0) && !Core.hasVoice(0.03) && !Core.hasVoice(undefined) && !Core.hasVoice('x'));
  assert.match(Core.errorText('no_voice'), /couldn't hear your voice/);
  const js = read('interview.js');
  assert.ok(js.includes('Core.hasVoice(') && js.includes('const silent = interview && S.take && !S.take.voiced'), 'the page checks for voice before offering Send');
  assert.ok(js.includes("(silent ? '' : '<button class=\"w-btn\" type=\"button\" data-action=\"send\">Send answer</button>')"), 'no Send button for a silent recording');
});

test('chat text is escaped', () => {
  assert.equal(Core.escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});

test('interview page: files, order of scripts, no storage of audio, leave handling', () => {
  const html = read('interview.html');
  assert.match(html, /<meta name="robots" content="noindex">/, 'interview links must not be indexed');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.ok(html.indexOf('supabase-config.js') < html.indexOf('interview-core.js'));
  assert.ok(html.indexOf('interview-core.js') < html.indexOf('interview.js'));
  for (const asset of ['styles.css', 'interview-core.js', 'interview.js']) {
    assert.ok(new RegExp(asset.split('.').join('[.]') + '[?]v=[\w-]+').test(html), asset + ' carries a version');
  }
  const js = read('interview.js');
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/, 'nothing about the interview is kept in the browser');
  assert.match(js, /sendBeacon/);
  assert.match(js, /pagehide/);
  assert.match(js, /beforeunload/);
  assert.match(js, /event\.persisted/, 'a page kept in the back/forward cache is not a "leave"');
  assert.match(js, /The AI does not determine who passes or fails/);
  assert.match(js, /If you leave or refresh this page after the first question, the interview is cancelled/);
  assert.match(js, /Tell me about your career so far/);
  assert.match(js, /accentTokens/);
  assert.ok(js.includes('data-action="delete">Try again</button>'), 'after Stop the button is called Try again');
  assert.ok(!/>Delete</.test(js) && !js.includes("'Record again'"), 'no Delete button any more');
  const recording = js.slice(js.indexOf("S.mode === 'recording') {"), js.indexOf("S.mode === 'recorded') {"));
  assert.ok(recording.includes('data-action="stop"') && !recording.includes('data-action="delete"'), 'while recording the only button is Stop');
  const recorded = js.slice(js.indexOf("S.mode === 'recorded') {"), js.indexOf("S.mode === 'sending') {"));
  assert.ok(recorded.includes('timeIsUp') && recorded.includes('data-action="skip"') && recorded.includes('data-action="send"'), 'after time-up: Skip and Send');
  assert.match(js, /TEST_MAX_SECONDS/, 'the microphone test is limited to one minute');
  assert.match(js, /id="wave"/, 'there is a sound wave while recording');
  assert.ok(js.includes("addDivider('The interview starts now')"), 'the interview continues the same chat');
  assert.ok(!js.includes("list.innerHTML = ''"), 'starting the interview never clears the conversation');
  assert.doesNotMatch(js, /action: 'answer'[\s\S]{0,400}localStorage/);
});

test('a late presence signal never replaces the screen the person is on', () => {
  const js = read('interview.js');
  const beat = js.slice(js.indexOf("action: 'heartbeat'"), js.indexOf('}, HEARTBEAT_MS)'));
  const ignoreStale = beat.indexOf("if (!S.started || S.screen !== 'chat') return;");
  assert.ok(ignoreStale > 0, 'results that arrive after the interview ended are ignored');
  assert.ok(ignoreStale < beat.indexOf("result.status === 401) {"), 'the check comes before any screen is replaced');
  assert.ok(beat.includes("result.status === 401 && S.mode === 'sending'"), 'a 401 while the last answer is being sent is not an error');
});

test('the stylesheet and script versions agree across pages', () => {
  const versions = new Set();
  for (const file of ['index.html', 'interview.html']) for (const match of read(file).matchAll(/\?v=([\w-]+)/g)) versions.add(match[1]);
  assert.equal(versions.size, 1, `all assets use one version: ${[...versions]}`);
});
