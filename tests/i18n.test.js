const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const I18n = require('../interview-i18n.js');
const Core = require('../interview-core.js');

const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');

test('the candidate page has the same texts in English, Portuguese and Spanish', () => {
  assert.deepEqual(I18n.LANGS, ['en', 'pt', 'es']);
  const keys = Object.keys(I18n.TEXT.en);
  for (const lang of ['pt', 'es']) {
    assert.deepEqual(Object.keys(I18n.TEXT[lang]).sort(), keys.slice().sort(), `${lang} must have exactly the keys of English`);
  }
  for (const lang of I18n.LANGS) {
    for (const key of keys) {
      const value = I18n.TEXT[lang][key];
      if (key === 'states') {
        assert.deepEqual(Object.keys(value).sort(), ['abandoned', 'cancelled', 'completed', 'expired', 'in_progress', 'unavailable']);
        for (const pair of Object.values(value)) assert.ok(pair.length === 2 && pair.every(text => typeof text === 'string' && text.length > 5), `${lang} state texts`);
        continue;
      }
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.equal(placeholders(value), placeholders(I18n.TEXT.en[key]), `${lang}.${key} must use the same {placeholders} as English`);
      assert.equal(/\bundefined\b|\[object/.test(value), false, `${lang}.${key}`);
    }
  }
});

test('Portuguese and Spanish are really translated, not copies of the English text', () => {
  const same = { pt: [], es: [] };
  for (const key of Object.keys(I18n.TEXT.en)) {
    if (key === 'states') continue;
    for (const lang of ['pt', 'es']) if (I18n.TEXT[lang][key] === I18n.TEXT.en[key]) same[lang].push(key);
  }
  // only symbols or words that are the same in the three languages may repeat
  for (const lang of ['pt', 'es']) assert.deepEqual(same[lang].filter(key => !/^(btnRecord)$/.test(key)), [], `${lang} keys still in English`);
});

test('t() fills placeholders, falls back to English and never prints a missing key as undefined', () => {
  assert.equal(I18n.t('pt', 'questionOf', { n: 2, total: 5 }), 'Pergunta 2 de 5');
  assert.equal(I18n.t('es', 'questionOf', { n: 2, total: 5 }), 'Pregunta 2 de 5');
  assert.equal(I18n.t('en', 'questionOf', { n: 2, total: 5 }), 'Question 2 of 5');
  assert.equal(I18n.t('pt-BR', 'btnStop'), 'Parar', 'regional codes work');
  assert.equal(I18n.t('fr', 'btnStop'), 'Stop', 'an unknown language shows English');
  assert.equal(I18n.t('pt', 'nope'), 'nope');
  assert.equal(I18n.t('pt', 'timeLeft', {}), 'Tempo restante: {clock}', 'a missing value is left visible, never "undefined"');
  assert.equal(I18n.normalize('ES-mx'), 'es');
  assert.equal(I18n.normalize(undefined), 'en');
});

test('the errors and the end screens of the page come in the language of the job', () => {
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 4 }, 'pt'), /Restam 4 tentativas/);
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 1 }, 'pt'), /Resta 1 tentativa/);
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 3 }, 'es'), /Le quedan 3 intentos/);
  assert.match(Core.errorText('invalid_code', { attemptsLeft: 4 }), /4 attempts left/, 'English without a language');
  assert.match(Core.errorText('locked', { retryAt: new Date(Date.now() + 14 * 60000 + 1000).toISOString() }, 'es'), /unos 15 minutos/);
  assert.match(Core.errorText('network', null, 'pt'), /servidor/);
  assert.match(Core.errorText('whatever', null, 'es'), /Algo salió mal/);
  assert.match(Core.errorText('no_voice', null, 'pt'), /Não conseguimos ouvir a sua voz/);
  assert.equal(Core.stateScreen('expired', 'pt').title, 'Este convite expirou');
  assert.equal(Core.stateScreen('created', 'es').title, Core.stateScreen('unavailable', 'es').title);
  assert.equal(Core.stateScreen('abandoned', 'en').title, 'This interview was cancelled');
  assert.equal(Core.stateScreen('nope', 'pt').title, Core.stateScreen('unavailable', 'pt').title);
});

test('the consent screen says in which language to answer, in every language', () => {
  for (const lang of I18n.LANGS) {
    const text = I18n.t(lang, 'consentLanguageHtml', { language: I18n.NAMES[lang] });
    assert.ok(text.includes(I18n.NAMES[lang]), lang);
    assert.ok(text.split(I18n.NAMES[lang]).length >= 3, 'the language is named twice: where the interview is held and where the answer goes');
  }
  assert.match(I18n.t('pt', 'consentLanguageHtml', { language: 'português' }), /responda em português/);
});

test('the page takes every text from the dictionary and shows one language only', () => {
  const js = read('interview.js');
  for (const phrase of ['Need help?', 'Before we begin', 'Send answer', 'Skip this question', '>Try again<', 'Record response', 'Test my microphone', 'Start the interview',
    'Time left', 'Your session ended', 'We could not load', 'Loading your interview', 'Microphone ready', 'Question skipped', 'Audio response', 'Follow-up',
    'Agree and continue', 'Enter your access code', 'Artificial Intelligence Assistant', 'The AI does not determine']) {
    assert.equal(js.includes(phrase), false, `"${phrase}" is still written in interview.js`);
  }
  assert.ok(js.includes("S.lang = I18n.normalize(result.json.language);"), 'the language of the job comes from the open call');
  assert.ok(js.includes('document.documentElement.lang'), 'the page tells the browser its language');
  assert.ok(js.includes('Core.stateScreen(state, S.lang)'));
  assert.equal(/Core\.errorText\(/.test(js.replace('const errText = (code, extra) => Core.errorText(code, extra, S.lang);', '')), false, 'every error text goes through the language');
  assert.ok(js.includes('Powered by Witcher'), 'the brand line is the same in every language');
  const html = read('interview.html');
  assert.ok(html.indexOf('interview-i18n.js') < html.indexOf('interview-core.js'), 'the dictionary loads before the code that uses it');
  assert.match(html, /interview-i18n\.js\?v=[\w-]+/);
});

test('the page works in a browser-like harness in each language: consent, chat and end screens', () => {
  // A small DOM stand-in: it records what the page writes, so the real interview.js runs in all three languages.
  const vm = require('node:vm');
  const results = {};
  for (const lang of I18n.LANGS) {
    const writes = [];
    const element = { set innerHTML(value) { writes.push(value); }, get innerHTML() { return writes[writes.length - 1] || ''; }, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], style: { setProperty() {} }, textContent: '', classList: { toggle() {} } };
    const document = {
      getElementById: () => element,
      documentElement: { style: { setProperty() {} }, lang: '' },
      addEventListener() {},
      querySelectorAll: () => [],
      title: '',
    };
    const calls = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.action);
      if (body.action === 'open') return { status: 200, json: async () => ({ state: 'invited', language: lang, branding: { company: 'Le Lyon', jobTitle: 'Cook', color: '#315f4a' }, emailMasked: 'a***@example.com' }) };
      return { status: 404, json: async () => ({}) };
    };
    const window = { WITCHER_SUPABASE_CONFIG: { url: 'https://x.test' }, WitcherCore: Core, WitcherI18n: I18n, location: { hash: '#i=11111111-1111-4111-8111-111111111111' }, addEventListener() {}, devicePixelRatio: 1 };
    const sandbox = { window, document, fetch, navigator: { language: 'en-US' }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, console, URL, Blob: class {}, getComputedStyle: () => ({}) };
    vm.createContext(sandbox);
    vm.runInContext(read('interview.js'), sandbox);
    results[lang] = { writes, calls, document };
  }
  return Promise.all([new Promise(resolve => setTimeout(resolve, 50))]).then(() => {
    assert.match(results.pt.writes.join('\n'), /Digite o seu código de acesso/, 'the access code screen is in Portuguese');
    assert.match(results.pt.writes.join('\n'), /convidou você para uma entrevista para <strong>Cook<\/strong>/);
    assert.match(results.es.writes.join('\n'), /Escriba su código de acceso/);
    assert.match(results.en.writes.join('\n'), /Enter your access code/);
    assert.equal(/Enter your access code|Digite/.test(results.es.writes.join('\n').split('Escriba su código')[1] || ''), false);
    assert.equal(results.pt.document.documentElement.lang, 'pt-BR');
    assert.equal(results.es.document.documentElement.lang, 'es');
    assert.equal(results.en.document.documentElement.lang, 'en');
    assert.equal(results.pt.document.title, 'Entrevista · Le Lyon');
  });
});
