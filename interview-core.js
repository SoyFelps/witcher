/*
 * Pure helpers of the candidate interview page (no DOM, no network), so Node can test them.
 * In the browser they are exposed as window.WitcherCore; in Node as module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WitcherCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const ANSWER_SECONDS = 180;
  const WARN_SECONDS = 30;
  const TEST_MAX_SECONDS = 60; // the microphone test recording is cut after one minute
  const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

  /** The interview link is `interview.html#i=<link id>`. Returns the id, or null when it is missing or malformed. */
  function parseLinkId(hash) {
    const match = String(hash || '').match(/(?:^|[#&])i=([^&]+)/);
    if (!match) return null;
    try {
      const value = decodeURIComponent(match[1]);
      return UUID_RE.test(value) ? value.toLowerCase() : null;
    } catch (error) {
      return null;
    }
  }

  /** 125 -> "2:05". */
  function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function isValidColor(value) {
    return COLOR_RE.test(String(value || ''));
  }

  function luminance(hex) {
    const channel = index => {
      const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  }

  /** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
  function contrastRatio(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  }

  /** Text colour that stays readable on top of a brand colour: white on dark colours, near-black on light ones. */
  function contrastText(hex) {
    if (!isValidColor(hex)) return '#ffffff';
    return luminance(hex) > 0.4 ? '#17251e' : '#ffffff';
  }

  /** `ratio` of colour A mixed with the rest of colour B, as #rrggbb. */
  function mixHex(a, b, ratio) {
    const part = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return '#' + [0, 1, 2].map(i => Math.round(part(a, i) * ratio + part(b, i) * (1 - ratio)).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Every colour of the page derived from the company's brand colour: soft, mid and line tints for backgrounds and
   * borders, and an ink for text on those tints that is always dark enough to read (contrast of at least 4.5).
   */
  function accentTokens(hex) {
    if (!isValidColor(hex)) return null;
    const white = '#ffffff';
    const soft = mixHex(hex, white, 0.12);
    let ink = hex;
    for (let ratio = 1; contrastRatio(ink, soft) < 4.5 && ratio > 0; ) {
      ratio = Math.max(0, ratio - 0.1);
      ink = mixHex(hex, '#17251e', ratio);
    }
    return { accent: hex, onAccent: contrastText(hex), soft, mid: mixHex(hex, white, 0.22), line: mixHex(hex, white, 0.4), ink };
  }

  /** First format the browser can record in, from `isSupported(mime)` (MediaRecorder.isTypeSupported). */
  function pickMimeType(isSupported) {
    for (const mime of MIME_PREFERENCE) {
      try { if (isSupported(mime)) return mime; } catch (error) { /* try the next one */ }
    }
    return '';
  }

  /** Whole seconds left for an answer, from the deadline (ms since epoch). */
  function secondsLeftFrom(deadlineMs, nowMs) {
    return Math.max(0, Math.min(ANSWER_SECONDS, Math.ceil((deadlineMs - nowMs) / 1000)));
  }

  function timerTone(secondsLeft) {
    if (secondsLeft <= 0) return 'over';
    return secondsLeft <= WARN_SECONDS ? 'warn' : 'ok';
  }

  const STATE_SCREENS = {
    cancelled: ['This interview was cancelled', 'The hiring team cancelled this interview. If you think this is a mistake, please contact them.'],
    expired: ['This invitation has expired', 'This interview link is no longer valid. Please ask the hiring team to send you a new invitation.'],
    completed: ['Interview already completed', 'Thank you. Your answers were already sent to the hiring team.'],
    abandoned: ['This interview was cancelled', 'The interview was closed after it started, so it cannot be resumed. Please contact the hiring team if you would like to try again.'],
    in_progress: ['This interview is already open', 'This interview was already started, in another window or earlier, so it cannot be opened again. Please contact the hiring team if you need help.'],
    unavailable: ['This link is not available', 'This interview link is not valid. Please check the link in your e-mail or ask the hiring team for a new invitation.'],
    created: ['This link is not available', 'This interview link is not valid. Please check the link in your e-mail or ask the hiring team for a new invitation.'],
  };

  /** Title and text for a screen that ends the flow (the interview cannot continue). */
  function stateScreen(state) {
    const found = STATE_SCREENS[state] || STATE_SCREENS.unavailable;
    return { title: found[0], text: found[1] };
  }

  /** User-facing text for an error code from the session function. `extra` carries attemptsLeft or retryAt. */
  function errorText(code, extra) {
    const info = extra || {};
    switch (code) {
      case 'invalid_code': {
        const left = Number(info.attemptsLeft);
        return Number.isFinite(left) && left > 0
          ? `That code is not correct. You have ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`
          : 'That code is not correct.';
      }
      case 'locked': {
        const at = info.retryAt ? new Date(info.retryAt) : null;
        const minutes = at && !Number.isNaN(at.getTime()) ? Math.max(1, Math.ceil((at.getTime() - (info.now || Date.now())) / 60000)) : 15;
        return `Too many wrong codes. Please wait about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again.`;
      }
      case 'consent_required': return 'Please accept the terms to continue.';
      case 'time_over': return 'The time to send this answer has passed. You can skip to the next question.';
      case 'out_of_sync': return 'Something went out of sync. Please try again.';
      case 'ai_unavailable': return 'The AI assistant is not available right now. Please try sending your answer again in a moment.';
      case 'ai_not_configured': return 'The AI assistant is not available right now. Please try again later.';
      case 'audio_invalid': return 'We could not use that recording. Please record your answer again.';
      case 'network': return 'We could not reach the server. Check your connection and try again.';
      default: return 'Something went wrong. Please try again.';
    }
  }

  /** The characters of the access code the person typed, as the server expects them (digits only, at most 6). */
  function cleanCode(value) {
    return String(value == null ? '' : value).replace(/\D/g, '').slice(0, 6);
  }

  /** "14:05" style time for the chat bubbles. */
  function clockTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return {
    ANSWER_SECONDS, WARN_SECONDS, TEST_MAX_SECONDS, parseLinkId, formatClock, isValidColor, contrastText, contrastRatio, mixHex, accentTokens, pickMimeType,
    secondsLeftFrom, timerTone, stateScreen, errorText, cleanCode, clockTime, escapeHtml,
  };
});
