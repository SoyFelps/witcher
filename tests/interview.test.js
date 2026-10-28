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
  assert.doesNotMatch(js, /action: 'answer'[\s\S]{0,400}localStorage/);
});

test('the stylesheet and script versions agree across pages', () => {
  const versions = new Set();
  for (const file of ['index.html', 'interview.html']) for (const match of read(file).matchAll(/\?v=([\w-]+)/g)) versions.add(match[1]);
  assert.equal(versions.size, 1, `all assets use one version: ${[...versions]}`);
});
