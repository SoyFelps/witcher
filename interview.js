/*
 * Candidate interview page: link -> access code -> consent -> microphone test -> interview -> done.
 * Everything the server needs goes through the `session` edge function. The audio only lives in this browser
 * until it is sent; it is never stored. Needs interview-core.js (WitcherCore) and supabase-config.js first.
 */
(function () {
  'use strict';
  const Core = window.WitcherCore;
  const esc = Core.escapeHtml;
  const root = document.getElementById('app');
  const HEARTBEAT_MS = 15000;
  const DISCLAIMER = "The AI does not determine who passes or fails in the selection process; it only facilitates the recruiter's role in choosing the best candidate for the position. The company is responsible for reviewing your responses.";
  const TEST_QUESTION = 'Tell me about your career so far.';

  const S = {
    linkId: null, branding: null, emailMasked: '', consentVersion: '', token: '', firstName: '', total: 3,
    screen: 'loading', phase: 'intro', mode: 'idle', messages: [], prompt: null, deadline: 0,
    take: null, rec: null, testAsked: false, notice: '', devices: [], deviceId: '', timer: null, beat: null, started: false,
  };

  // ---------------------------------------------------------------------------------------------- server
  async function api(body) {
    const config = window.WITCHER_SUPABASE_CONFIG;
    if (!config || !config.url) return { status: 0, json: { error: 'network' } };
    let response;
    try {
      response = await fetch(`${config.url}/functions/v1/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (error) {
      return { status: 0, json: { error: 'network' } };
    }
    let json = null;
    try { json = await response.json(); } catch (error) { /* empty body */ }
    return { status: response.status, json: json || {} };
  }

  // ---------------------------------------------------------------------------------------------- microphone
  const Mic = {
    stream: null, context: null, analyser: null, frame: 0, level: 0,
    async open() {
      if (this.stream && this.stream.getTracks().some(track => track.readyState === 'live')) return;
      const audio = S.deviceId ? { deviceId: { exact: S.deviceId } } : true;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        S.devices = devices.filter(device => device.kind === 'audioinput');
        const live = this.stream.getAudioTracks()[0] && this.stream.getAudioTracks()[0].getSettings().deviceId;
        if (!S.deviceId && live) S.deviceId = live;
      } catch (error) { /* the list is optional */ }
      this.meter();
    },
    close() {
      cancelAnimationFrame(this.frame);
      if (this.stream) this.stream.getTracks().forEach(track => track.stop());
      if (this.context) { try { this.context.close(); } catch (error) { /* already closed */ } }
      this.stream = null; this.context = null; this.analyser = null;
    },
    readLevel() {
      if (!this.analyser) return 0;
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
      return Math.min(1, peak / 64);
    },
    meter() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        this.context = new AudioContextClass();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256;
        this.context.createMediaStreamSource(this.stream).connect(this.analyser);
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        const draw = () => {
          this.analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
          this.level = Math.min(1, peak / 64);
          const bar = document.getElementById('meter');
          if (bar) bar.style.width = `${Math.min(100, Math.round(peak / 64 * 100))}%`;
          this.frame = requestAnimationFrame(draw);
        };
        draw();
      } catch (error) { /* the level bar is only a nicety */ }
    },
  };

  // A generic sound wave while recording: bars rise with the voice and stay flat in silence (it is only feedback).
  const Wave = {
    frame: 0, levels: [], last: 0,
    start(canvas) {
      this.stop();
      if (!canvas || !canvas.getContext) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 240, height = canvas.clientHeight || 44;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      const color = getComputedStyle(canvas).color;
      const barWidth = 3, gap = 3, count = Math.max(10, Math.floor(width / (barWidth + gap)));
      this.levels = new Array(count).fill(0);
      const draw = (now) => {
        if (now - this.last > 55) {
          this.last = now;
          const raw = Mic.level;
          this.levels.push(raw < 0.06 ? 0 : Math.min(1, (raw - 0.06) / 0.7)); // a noise gate keeps silence flat
          this.levels.shift();
        }
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = color;
        this.levels.forEach((level, index) => {
          const barHeight = Math.max(3, level * height);
          ctx.fillRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
        });
        this.frame = requestAnimationFrame(draw);
      };
      this.frame = requestAnimationFrame(draw);
    },
    stop() { cancelAnimationFrame(this.frame); this.frame = 0; },
  };

  function micErrorText(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return "Microphone access is blocked. Allow the microphone in your browser's address bar and try again.";
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.';
    return 'We could not start the microphone. Check it is not in use by another app and try again.';
  }

  // ---------------------------------------------------------------------------------------------- layout
  function header() {
    const b = S.branding;
    const initial = esc(((b && b.company) || 'W').trim().charAt(0).toUpperCase() || 'W');
    const logo = b && b.logoUrl && /^https:\/\//.test(b.logoUrl)
      ? `<img class="w-logo" src="${esc(b.logoUrl)}" alt="">`
      : `<span class="w-mark">${initial}</span>`;
    return `<header class="w-top">
      <div class="w-top-brand">${logo}<span class="w-company">${esc((b && b.company) || 'Witcher')}</span><span class="w-powered">Powered by Witcher</span></div>
      <button class="w-help" type="button" data-action="help" aria-expanded="false">Need help?</button>
    </header>
    <div class="w-help-panel" id="help" hidden>Find a quiet place, allow microphone access when the browser asks, and use a recent version of Chrome, Edge, Firefox or Safari. If something does not work, contact the hiring team that invited you.</div>`;
  }

  function foot() {
    return `<footer class="w-foot">Your voice is turned into text by an AI service. The audio is not stored; only the text of your answers is kept and shared with the hiring team.</footer>`;
  }

  function mount(html) {
    root.innerHTML = `${header()}<main class="w-stage" id="stage">${html}</main>${foot()}`;
  }

  function applyBranding() {
    const b = S.branding;
    const tokens = Core.accentTokens(b && b.color);
    const style = document.documentElement.style;
    if (tokens) {
      // Everything on the page that is tinted comes from the company's colour (a variation of it), not from the Witcher green.
      style.setProperty('--accent', tokens.accent); style.setProperty('--on-accent', tokens.onAccent);
      style.setProperty('--accent-soft', tokens.soft); style.setProperty('--accent-mid', tokens.mid);
      style.setProperty('--accent-line', tokens.line); style.setProperty('--accent-ink', tokens.ink);
    }
    document.title = b && b.company ? `Interview · ${b.company}` : 'Interview · Witcher';
  }

  function card(title, text, extra) {
    return `<section class="w-card w-card-wide"><h1>${esc(title)}</h1><p>${esc(text)}</p>${extra || ''}</section>`;
  }

  function showMessage(title, text) {
    stopLive();
    S.screen = 'message';
    mount(card(title, text));
  }

  function showState(state) {
    const info = Core.stateScreen(state);
    showMessage(info.title, info.text);
  }

  // ---------------------------------------------------------------------------------------------- screens
  function showCode(error) {
    S.screen = 'code';
    mount(`<section class="w-card w-card-wide">
      <h1>Enter your access code</h1>
      <p>${esc(S.branding.company)} invited you to an interview for <strong>${esc(S.branding.jobTitle)}</strong>. We sent a 6-digit code to <strong>${esc(S.emailMasked)}</strong>.</p>
      <form id="code-form" novalidate>
        <label class="w-label" for="code">Access code</label>
        <input class="w-input w-code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-describedby="code-error" autofocus>
        <p class="w-error" id="code-error" role="alert">${error ? esc(error) : ''}</p>
        <button class="w-btn" type="submit" id="code-submit">Continue</button>
      </form>
    </section>`);
    const form = document.getElementById('code-form');
    const input = document.getElementById('code');
    input.addEventListener('input', () => { input.value = Core.cleanCode(input.value); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = Core.cleanCode(input.value);
      const errorBox = document.getElementById('code-error');
      if (code.length !== 6) { errorBox.textContent = 'Enter the 6 digits from your e-mail.'; return; }
      const button = document.getElementById('code-submit');
      button.disabled = true; errorBox.textContent = '';
      const result = await api({ action: 'verify', linkId: S.linkId, code });
      if (result.status === 200) {
        S.token = result.json.sessionToken;
        S.consentVersion = result.json.consentVersion;
        S.total = result.json.totalQuestions || 3;
        S.firstName = result.json.candidateFirstName || '';
        if (result.json.branding) { S.branding = result.json.branding; applyBranding(); }
        showConsent();
        return;
      }
      if (result.status === 409 && result.json.state) { showState(result.json.state); return; }
      if (result.status === 404) { showState('unavailable'); return; }
      button.disabled = false;
      errorBox.textContent = Core.errorText(result.json.error, { ...result.json, now: Date.now() });
    });
  }

  function showConsent(error) {
    S.screen = 'consent';
    const company = esc(S.branding.company);
    mount(`<section class="w-card w-card-wide">
      <h1>Before we begin</h1>
      <p>This is an interview with an AI assistant for <strong>${esc(S.branding.jobTitle)}</strong> at <strong>${company}</strong>.</p>
      <ul class="w-list">
        <li>You will be asked ${esc(S.total)} ${S.total === 1 ? 'question' : 'questions'} and answer each one <strong>out loud</strong>, with up to <strong>3 minutes</strong> per answer. After some answers the AI asks one follow-up question.</li>
        <li>Your voice is sent to an AI service that turns it into text. <strong>The audio is not stored.</strong> Only the text of your answers is kept and shared with ${company}.</li>
        <li>The AI does not decide who moves forward. ${company} reviews your answers.</li>
        <li><strong>If you leave or refresh this page after the first question, the interview is cancelled</strong> and cannot be resumed.</li>
        <li>You will need a quiet place and a working microphone.</li>
      </ul>
      <label class="w-check"><input type="checkbox" id="agree"> <span>I have read this and agree to the recording and processing of my voice described above.</span></label>
      <p class="w-error" id="consent-error" role="alert">${error ? esc(error) : ''}</p>
      <button class="w-btn" type="button" id="consent-go" disabled>Agree and continue</button>
    </section>`);
    const agree = document.getElementById('agree');
    const go = document.getElementById('consent-go');
    agree.addEventListener('change', () => { go.disabled = !agree.checked; });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const result = await api({ action: 'consent', sessionToken: S.token, accepted: true, version: S.consentVersion });
      if (result.status === 200) { showIntro(); return; }
      if (result.status === 401) { showMessage('Your session ended', 'For your security the session ended. Open the link in your e-mail again to continue.'); return; }
      if (result.status === 409 && result.json.state) { showState(result.json.state); return; }
      go.disabled = false;
      document.getElementById('consent-error').textContent = Core.errorText(result.json.error);
    });
  }

  function chatShell() {
    return `<h1 class="w-title">AI Interview</h1><p class="w-sub">Talk naturally just like you would in a regular interview.</p>
    <section class="w-chat" aria-label="Interview">
      <div class="w-chat-head"><span class="w-ai-icon" aria-hidden="true">✦</span>
        <div class="w-chat-head-text"><strong>${esc(S.branding.jobTitle)}</strong><small>Artificial Intelligence Assistant</small></div>
        <span class="w-progress" id="progress"></span></div>
      <div class="w-msgs" id="msgs" aria-live="polite"></div>
      <div class="w-dock" id="dock"></div>
    </section>`;
  }

  function showIntro() {
    S.screen = 'chat'; S.phase = 'intro'; S.mode = 'idle'; S.messages = []; S.testAsked = false; S.notice = '';
    mount(chatShell());
    clearInterval(S.timer);
    S.timer = setInterval(tick, 250); // the recording counter of the microphone test also needs it
    addMessage('ai', DISCLAIMER);
    addMessage('ai', 'Would you like to test your microphone first? Your test recording stays in your browser and is not saved or sent anywhere.');
    document.getElementById('progress').textContent = 'Microphone check';
    renderDock();
  }

  function showDone() {
    stopLive();
    S.screen = 'done';
    mount(`<section class="w-card w-card-wide w-done"><span class="w-done-icon" aria-hidden="true">✓</span>
      <h1>Thank you${S.firstName ? ', ' + esc(S.firstName) : ''}!</h1>
      <p>Your interview is complete and your answers were sent to ${esc(S.branding.company)}. They will review them and contact you if they would like to move forward. You can close this page now.</p></section>`);
  }

  // ---------------------------------------------------------------------------------------------- chat
  function addMessage(role, text, extra) {
    const entry = { role, text, time: Core.clockTime(new Date()), ...(extra || {}) };
    S.messages.push(entry);
    const list = document.getElementById('msgs');
    if (!list) return;
    clearCurrent(list); // only the question being answered is highlighted
    const company = esc((S.branding && S.branding.company) || 'Witcher');
    const html = role === 'ai'
      ? `<div class="w-msg w-msg-ai"><span class="w-ai-icon" aria-hidden="true">✦</span><div class="w-msg-body">
          <div class="w-msg-meta"><strong>${company}</strong> <span class="w-tag">AI</span> <span>${esc(entry.time)}</span>${extra && extra.current ? ' <span class="w-turn">Your turn to respond</span>' : ''}</div>
          <div class="w-bubble${extra && extra.current ? ' w-bubble-current' : ''}">${esc(text)}</div></div></div>`
      : `<div class="w-msg w-msg-you"><div class="w-msg-meta">You · ${esc(entry.time)}</div>
          <div class="w-audio"><span class="w-audio-icon" aria-hidden="true">🎙</span><span>${esc(text)}</span><span class="w-sent" aria-hidden="true">${extra && extra.skipped ? '' : '✓'}</span></div></div>`;
    list.insertAdjacentHTML('beforeend', html);
    list.scrollTop = list.scrollHeight;
  }

  function clearCurrent(list) {
    list.querySelectorAll('.w-turn').forEach(node => node.remove());
    list.querySelectorAll('.w-bubble-current').forEach(node => node.classList.remove('w-bubble-current'));
  }

  // A line in the same conversation: the interview continues the chat, it does not open a new one.
  function addDivider(text) {
    const list = document.getElementById('msgs');
    if (!list) return;
    clearCurrent(list);
    list.insertAdjacentHTML('beforeend', `<div class="w-divider"><span>${esc(text)}</span></div>`);
    list.scrollTop = list.scrollHeight;
  }

  // The dock under the chat: whose turn it is, the timer and the recording buttons.
  function renderDock() {
    const dock = document.getElementById('dock');
    if (!dock) return;
    Wave.stop();
    const interview = S.phase === 'interview';
    const name = S.firstName ? `, ${esc(S.firstName)}` : '';
    const left = S.rec && S.rec.state === 'recording' ? Core.formatClock((Date.now() - S.rec.startedAt) / 1000) : '';
    let title = 'Microphone check';
    let sub = 'Test it as many times as you like. Nothing is saved.';
    let buttons = '';

    if (interview) {
      title = `Now it's your turn${name}`;
      sub = `<span id="timer" class="w-timer">You have 3 minutes to read and answer the question</span>`;
    }
    if (S.mode === 'idle') {
      if (!interview && !S.testAsked) {
        buttons = `<button class="w-btn w-btn-ghost" type="button" data-action="test-mic">Test my microphone</button><button class="w-btn" type="button" data-action="start">Start the interview</button>`;
        title = 'Ready when you are'; sub = 'You can test your microphone first, or start right away.';
      } else {
        buttons = `<button class="w-btn" type="button" data-action="record" id="record-btn">● Record response</button>${interview ? '' : '<button class="w-btn w-btn-ghost" type="button" data-action="start">Start the interview</button>'}`;
      }
    } else if (S.mode === 'recording') {
      sub = interview ? sub : 'Recording… speak now.';
      buttons = `<span class="w-rec" aria-live="off"><i></i> <span id="elapsed">${left}</span></span><button class="w-btn" type="button" data-action="stop">Stop</button>`; // nothing else while recording
    } else if (S.mode === 'recorded') {
      const player = S.take ? `<audio class="w-player" controls src="${esc(S.take.url)}"></audio>` : '';
      const timeIsUp = interview && Core.secondsLeftFrom(S.deadline, Date.now()) <= 0;
      const second = timeIsUp
        ? '<button class="w-btn w-btn-ghost" type="button" data-action="skip">Skip this question</button>'
        : '<button class="w-btn w-btn-ghost" type="button" data-action="delete">Try again</button>';
      // A recording with no voice in it is never sent to the AI: it would only invent words. Try again (or skip) is offered instead.
      const silent = interview && S.take && !S.take.voiced;
      buttons = `${player}${second}${interview
        ? (silent ? '' : '<button class="w-btn" type="button" data-action="send">Send answer</button>')
        : '<button class="w-btn" type="button" data-action="start">Start the interview</button>'}`;
      if (silent && !S.notice) { S.notice = Core.errorText('no_voice'); S.noticeInfo = false; }
    } else if (S.mode === 'sending') {
      buttons = `<span class="w-wait"><i class="w-spin"></i> The AI is listening to your answer…</span>`;
    } else if (S.mode === 'timeup') {
      buttons = `<button class="w-btn w-btn-ghost" type="button" data-action="skip">Skip this question</button>`;
    }

    const picker = S.devices.length > 1
      ? `<select class="w-select" id="mic-select" aria-label="Microphone">${S.devices.map((device, index) => `<option value="${esc(device.deviceId)}"${device.deviceId === S.deviceId ? ' selected' : ''}>${esc(device.label || `Microphone ${index + 1}`)}</option>`).join('')}</select>`
      : '';
    const ready = Mic.stream ? `<span class="w-ready"><i></i> Microphone ready</span><span class="w-meter" aria-hidden="true"><i id="meter"></i></span>` : '<span class="w-ready w-ready-off"><i></i> Microphone not started yet</span>';
    const wave = S.mode === 'recording' ? '<canvas class="w-wave" id="wave" aria-hidden="true"></canvas>' : '';
    dock.innerHTML = `<div class="w-dock-main"><span class="w-mic-icon" aria-hidden="true">🎙</span>
        <div class="w-dock-text"><strong>${title}</strong><span class="w-dock-sub">${sub}</span></div>${wave}
        <div class="w-dock-actions">${buttons}</div></div>
      <p class="w-error${S.noticeInfo ? ' w-info' : ''}" role="alert" id="notice">${esc(S.notice)}</p>
      <div class="w-dock-mic">${ready}${picker}</div>`;
    if (Mic.stream) Mic.meter();
    if (S.mode === 'recording') Wave.start(document.getElementById('wave'));
    const select = document.getElementById('mic-select');
    if (select) select.addEventListener('change', async () => {
      S.deviceId = select.value; Mic.close();
      try { await Mic.open(); S.notice = ''; } catch (error) { S.notice = micErrorText(error); }
      renderDock();
    });
    tick();
  }

  function setNotice(text, info) {
    S.notice = text || ''; S.noticeInfo = !!info;
    const box = document.getElementById('notice');
    if (box) { box.textContent = S.notice; box.classList.toggle('w-info', !!info); }
  }

  // ---------------------------------------------------------------------------------------------- timer
  function tick() {
    if (S.screen !== 'chat') return;
    const elapsed = document.getElementById('elapsed');
    if (elapsed && S.rec && S.rec.state === 'recording') elapsed.textContent = Core.formatClock((Date.now() - S.rec.startedAt) / 1000);
    if (S.phase === 'intro' && S.rec && S.rec.state === 'recording' && (Date.now() - S.rec.startedAt) / 1000 >= Core.TEST_MAX_SECONDS) {
      S.notice = 'The test recording is limited to 1 minute, so it stopped.'; S.noticeInfo = true;
      stopRecording();
      return;
    }
    if (S.phase !== 'interview') return;
    const left = Core.secondsLeftFrom(S.deadline, Date.now());
    const label = document.getElementById('timer');
    if (label) {
      label.textContent = left > 0 ? `Time left: ${Core.formatClock(left)}`
        : (S.mode === 'recorded' ? 'Time is up. You can still send your answer, or skip.' : 'Time is up for this answer');
      label.className = `w-timer w-timer-${Core.timerTone(left)}`;
    }
    if (left > 0) return;
    if (S.mode === 'recording') stopRecording();
    else if (S.mode === 'idle') { S.mode = 'timeup'; setNotice(''); renderDock(); }
    else if (S.mode === 'recorded' && !S.skipShown) { S.skipShown = true; renderDock(); } // the person may still send, or skip
  }

  function startTimers() {
    clearInterval(S.timer); clearInterval(S.beat);
    S.timer = setInterval(tick, 250);
    S.beat = setInterval(async () => {
      const result = await api({ action: 'heartbeat', sessionToken: S.token });
      if (result.status === 401) { showMessage('Your session ended', 'The interview can no longer continue. Please contact the hiring team.'); return; }
      if (result.status === 200 && result.json.state && result.json.state !== 'in_progress') {
        if (result.json.state === 'completed') showDone(); else showState(result.json.state);
        return;
      }
      if (result.status === 200 && typeof result.json.secondsLeft === 'number') {
        const serverDeadline = Date.now() + result.json.secondsLeft * 1000;
        if (Math.abs(serverDeadline - S.deadline) > 2000) S.deadline = serverDeadline;
      }
    }, HEARTBEAT_MS);
  }

  function stopLive() {
    clearInterval(S.timer); clearInterval(S.beat);
    S.timer = null; S.beat = null; S.started = false;
    if (S.take) { URL.revokeObjectURL(S.take.url); S.take = null; }
    if (S.rec && S.rec.mr && S.rec.mr.state !== 'inactive') { try { S.rec.mr.stop(); } catch (error) { /* already stopped */ } }
    if (S.rec) clearInterval(S.rec.sampler);
    S.rec = null;
    Mic.close();
  }

  // ---------------------------------------------------------------------------------------------- recording
  async function startRecording() {
    setNotice('');
    try { await Mic.open(); } catch (error) { setNotice(micErrorText(error)); renderDock(); return; }
    if (!window.MediaRecorder) { setNotice('This browser cannot record audio. Please use a recent version of Chrome, Edge, Firefox or Safari.'); return; }
    const mimeType = Core.pickMimeType(type => MediaRecorder.isTypeSupported(type));
    let recorder;
    try { recorder = new MediaRecorder(Mic.stream, mimeType ? { mimeType } : undefined); }
    catch (error) { setNotice('We could not start the recording on this device.'); return; }
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
    S.rec = { mr: recorder, chunks, startedAt: Date.now(), state: 'recording', mimeType: recorder.mimeType || mimeType || 'audio/webm', peak: 0 };
    // The loudest moment of the recording tells whether any voice was captured (sampled on a timer, so it also works in a background tab).
    S.rec.sampler = setInterval(() => { S.rec.peak = Math.max(S.rec.peak, Mic.readLevel(), Mic.level); }, 150);
    recorder.start(250);
    S.mode = 'recording';
    renderDock();
  }

  function stopRecording() {
    const rec = S.rec;
    if (!rec || rec.state !== 'recording') return;
    rec.state = 'stopping';
    rec.mr.onstop = () => {
      if (S.rec !== rec) return;
      const blob = new Blob(rec.chunks, { type: rec.mimeType });
      const seconds = Math.min(Core.ANSWER_SECONDS, Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000)));
      rec.state = 'stopped';
      if (!blob.size) { S.mode = 'idle'; setNotice('Nothing was recorded. Please try again.'); renderDock(); return; }
      clearInterval(rec.sampler);
      S.take = { blob, url: URL.createObjectURL(blob), seconds, voiced: Core.hasVoice(Math.max(rec.peak, Mic.level)) };
      S.mode = 'recorded';
      renderDock();
    };
    try { rec.mr.stop(); } catch (error) { S.mode = 'idle'; renderDock(); }
  }

  function deleteTake() {
    if (S.rec && S.rec.state === 'recording') {
      S.rec.mr.onstop = null;
      try { S.rec.mr.stop(); } catch (error) { /* already stopped */ }
    }
    if (S.take) URL.revokeObjectURL(S.take.url);
    if (S.rec) clearInterval(S.rec.sampler);
    S.take = null; S.rec = null;
    // Deleting does not reset the answer timer.
    S.mode = S.phase === 'interview' && Core.secondsLeftFrom(S.deadline, Date.now()) <= 0 ? 'timeup' : 'idle';
    setNotice('');
    renderDock();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------------------------------------- interview
  function showPrompt(prompt, secondsLeft) {
    S.prompt = prompt;
    S.deadline = Date.now() + (typeof secondsLeft === 'number' ? secondsLeft : Core.ANSWER_SECONDS) * 1000;
    S.mode = 'idle'; S.take = null; S.rec = null; S.notice = ''; S.noticeInfo = false; S.skipShown = false;
    const kind = prompt.phase === 'followup' ? 'Follow-up' : `Question ${prompt.qIndex + 1} of ${S.total}`;
    const progress = document.getElementById('progress');
    if (progress) progress.textContent = kind;
    addMessage('ai', prompt.text, { current: true });
    renderDock();
  }

  async function startInterview() {
    setNotice('');
    try { await Mic.open(); } catch (error) { setNotice(micErrorText(error)); renderDock(); return; }
    if (S.take) { URL.revokeObjectURL(S.take.url); S.take = null; }
    S.rec = null;
    const result = await api({ action: 'start', sessionToken: S.token });
    if (result.status === 401) { showMessage('Your session ended', 'For your security the session ended. Open the link in your e-mail again to continue.'); return; }
    if (result.status !== 200) {
      if (result.json.state) { showState(result.json.state); return; }
      setNotice(Core.errorText(result.json.error)); renderDock(); return;
    }
    S.phase = 'interview'; S.started = true; S.total = result.json.totalQuestions || S.total;
    addDivider('The interview starts now');
    startTimers();
    showPrompt(result.json.prompt, result.json.secondsLeft);
  }

  async function sendAnswer(skip) {
    if (S.mode === 'sending') return;
    const take = S.take;
    const prompt = S.prompt;
    if (!skip && !take) return;
    const previous = S.mode;
    S.mode = 'sending'; setNotice(''); renderDock();
    let body = { action: 'answer', sessionToken: S.token, qIndex: prompt.qIndex, phase: prompt.phase };
    if (skip) body.skip = true;
    else {
      try { body = { ...body, audio: await blobToBase64(take.blob), mimeType: take.blob.type || 'audio/webm', durationSeconds: take.seconds }; }
      catch (error) { S.mode = previous; setNotice('We could not read the recording. Please record again.'); renderDock(); return; }
    }
    const result = await api(body);
    if (result.status === 200) {
      addMessage('you', skip ? 'Question skipped' : `Audio response · ${Core.formatClock(take.seconds)}`, { skipped: !!skip });
      if (take) URL.revokeObjectURL(take.url);
      S.take = null; S.rec = null;
      if (result.json.done) { showDone(); return; }
      showPrompt(result.json.prompt, result.json.secondsLeft);
      return;
    }
    if (result.status === 401) { showMessage('Your session ended', 'The interview can no longer continue. Please contact the hiring team.'); return; }
    if (result.status === 409 && result.json.state) { showState(result.json.state); return; }
    // The answer stays here so the person can try again (a lost connection never loses a recording).
    S.mode = previous;
    // The server says the time is over: a recording can no longer be sent, so only skipping is left.
    if (result.json.error === 'time_over') { S.deadline = 0; S.mode = 'timeup'; if (S.take) { URL.revokeObjectURL(S.take.url); S.take = null; } }
    setNotice(Core.errorText(result.json.error));
    renderDock();
  }

  // ---------------------------------------------------------------------------------------------- events
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'help') {
      const panel = document.getElementById('help');
      panel.hidden = !panel.hidden;
      target.setAttribute('aria-expanded', String(!panel.hidden));
    } else if (action === 'test-mic') {
      S.testAsked = true;
      addMessage('ai', TEST_QUESTION, { current: true });
      renderDock();
    } else if (action === 'record') startRecording();
    else if (action === 'stop') stopRecording();
    else if (action === 'delete') deleteTake();
    else if (action === 'send') sendAnswer(false);
    else if (action === 'skip') sendAnswer(true);
    else if (action === 'start') startInterview();
  });

  // Leaving a started interview cancels it, so warn first and tell the server when the page really closes.
  window.addEventListener('beforeunload', event => {
    if (!S.started) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', event => {
    if (!S.started || event.persisted || !S.token) return;
    const config = window.WITCHER_SUPABASE_CONFIG;
    try {
      navigator.sendBeacon(`${config.url}/functions/v1/session`, new Blob([JSON.stringify({ action: 'leave', sessionToken: S.token })], { type: 'text/plain' }));
    } catch (error) { /* the server's silence check cancels it anyway */ }
  });

  // ---------------------------------------------------------------------------------------------- start
  async function boot() {
    S.linkId = Core.parseLinkId(window.location.hash);
    mount('<section class="w-card w-card-wide"><p>Loading your interview…</p></section>');
    if (!S.linkId) { showState('unavailable'); return; }
    const result = await api({ action: 'open', linkId: S.linkId });
    if (result.status === 404) { showState('unavailable'); return; }
    if (result.status !== 200) { showMessage('We could not load the interview', Core.errorText(result.json.error)); return; }
    S.branding = result.json.branding;
    S.emailMasked = result.json.emailMasked || '';
    applyBranding();
    if (result.json.state !== 'invited') { showState(result.json.state); return; }
    showCode();
  }

  boot();
})();
