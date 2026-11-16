/* Flute Timer — hands-free play/rest stopwatch */
(() => {
  'use strict';

  const STORAGE_KEY = 'flute-timer.settings.v1';
  const FLOOR_TTL_MS = 6 * 60 * 60 * 1000;
  const MIN_SEGMENT_MS = 250;
  const DB_MIN = -80;
  const DB_MAX = 0;
  // Below this, a sample is digital silence (input muted or still starting),
  // not usable room tone. Never infer a gate from it.
  const BG_SILENCE_DB = -88;
  const BG_MIN_SAMPLES = 6;

  const $ = (id) => document.getElementById(id);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad2 = (n) => String(n).padStart(2, '0');

  const els = {
    statusPill: $('statusPill'),
    statusText: $('statusText'),
    timerCard: $('timerCard'),
    lapEyebrow: $('lapEyebrow'),
    lapIndex: $('lapIndex'),
    phasePill: $('phasePill'),
    phaseText: $('phaseText'),
    bigTime: $('bigTime'),
    timeMain: $('timeMain'),
    timeTenths: $('timeTenths'),
    hint: $('hint'),
    meterTrack: $('meterTrack'),
    meterFill: $('meterFill'),
    thresholdMark: $('thresholdMark'),
    gateLabel: $('gateLabel'),
    meterState: $('meterState'),
    meterCal: $('meterCal'),
    playTotal: $('playTotal'),
    restTotal: $('restTotal'),
    sessionTotal: $('sessionTotal'),
    ratioPlay: $('ratioPlay'),
    ratioRest: $('ratioRest'),
    ratio: document.querySelector('.ratio'),
    primaryBtn: $('primaryBtn'),
    primaryLabel: $('primaryLabel'),
    primaryIcon: $('primaryIcon'),
    resetBtn: $('resetBtn'),
    lapCounts: $('lapCounts'),
    lapList: $('lapList'),
    lapFoot: $('lapFoot'),
    lapFootText: $('lapFoot'),
    micName: $('micName'),
    sensitivity: $('sensitivity'),
    sensitivityValue: $('sensitivityValue'),
    restDelay: $('restDelay'),
    restDelayValue: $('restDelayValue'),
    onsetDelay: $('onsetDelay'),
    onsetDelayValue: $('onsetDelayValue'),
    calibrateBtn: $('calibrateBtn'),
    calibrateNote: $('calibrateNote'),
    toast: $('toast'),
    liveRegion: $('liveRegion'),
  };

  const ICONS = {
    mic: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8.8" y="2.8" width="6.4" height="11.4" rx="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M5.8 11.3a6.2 6.2 0 0 0 12.4 0M12 17.5V21M8.8 21h6.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="5" width="3.4" height="14" rx="1.1" fill="currentColor"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.1" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.2 5.7v12.6a.8.8 0 0 0 1.22.68l9.6-6.3a.8.8 0 0 0 0-1.36l-9.6-6.3a.8.8 0 0 0-1.22.68Z" fill="currentColor"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 8.5A8 8 0 1 0 20 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19 4.5v4.8h-4.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    spinner: '<span class="spinner" aria-hidden="true"></span>',
  };

  const SENSITIVITY_WORDS = [
    [20, 'Low'],
    [38, 'Gentle'],
    [62, 'Balanced'],
    [82, 'High'],
    [101, 'Very high'],
  ];

  const DEFAULT_SETTINGS = {
    sensitivity: 55,
    restDelay: 0.9,
    onsetDelay: 0.18,
    floorDb: null,
    calibratedAt: 0,
  };

  function readNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const saved = JSON.parse(raw);
      return {
        sensitivity: clamp(readNumber(saved.sensitivity, 55), 0, 100),
        restDelay: clamp(readNumber(saved.restDelay, 0.9), 0.4, 2),
        onsetDelay: clamp(readNumber(saved.onsetDelay, 0.18), 0.05, 0.5),
        floorDb: Number.isFinite(Number(saved.floorDb))
          ? clamp(Number(saved.floorDb), -82, -25)
          : null,
        calibratedAt: Math.max(0, readNumber(saved.calibratedAt, 0)),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  let settings = loadSettings();

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode or storage full — settings stay in memory */
    }
  }

  const state = {
    mode: 'idle', // idle | starting | calibrating | listening | paused | error
    phase: null, // play | rest
    phaseStart: 0,
    sessionStarted: false,
    segments: [],
    pausedDuration: 0,
    pausedPhase: null,
    errorMessage: '',
    floorDb: settings.floorDb ?? -68,
    thresholdDb: -52,
    smoothDb: null,
    rawDb: -100,
    above: false,
    aboveSince: null,
    lastAbove: null,
    cal: null,
    bgCal: null,
    audio: null,
    opToken: 0,
    rafId: 0,
    lastFrameTs: 0,
    wakeLock: null,
    resetArmedAt: 0,
    resetTimer: 0,
    toastTimer: 0,
    lastAddedLap: 0,
    lastAddedAt: 0,
    currentTimeEl: null,
    lastIcon: '',
    lastAriaTimer: '',
    lastLapRenderAt: 0,
  };

  /* -------------------------------------------------------------
     Formatting
     ------------------------------------------------------------- */
  function splitTime(ms) {
    const total = Math.max(0, Math.floor(ms));
    let seconds = Math.floor(total / 1000);
    const tenth = Math.floor((total % 1000) / 100);
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const main = hours > 0
      ? `${hours}:${pad2(minutes)}:${pad2(secs)}`
      : `${pad2(minutes)}:${pad2(secs)}`;
    return { main, tenths: `.${tenth}`, compact: main, tenth, hours, minutes, seconds: secs };
  }

  function formatTime(ms, tenths = true) {
    const t = splitTime(ms);
    return tenths ? `${t.main}${t.tenths}` : t.main;
  }

  function formatTimeLong(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}${rem ? ` ${rem} seconds` : ''}`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} hour${hrs === 1 ? '' : 's'} ${mins % 60} minutes`;
  }

  function formatDb(value) {
    return `${Math.round(value)} dB`;
  }

  function formatDelay(value) {
    return `${value.toFixed(value < 1 ? 1 : 1)}s`;
  }

  function sensitivityWord(value) {
    const pair = SENSITIVITY_WORDS.find(([limit]) => value < limit);
    return pair ? pair[1] : 'Very high';
  }

  function relativeCalibration(ts) {
    if (!ts) return 'not calibrated';
    const diff = Date.now() - ts;
    if (diff < 45 * 1000) return 'calibrated just now';
    if (diff < 60 * 60 * 1000) return `calibrated ${Math.max(1, Math.round(diff / 60000))} min ago`;
    if (diff < 24 * 60 * 60 * 1000) return `calibrated ${Math.round(diff / 3600000)} h ago`;
    return 'calibrated a while ago';
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setHTML(el, html, key) {
    if (!el) return;
    if (key !== undefined) {
      if (state.lastIcon === key) return;
      state.lastIcon = key;
    }
    el.innerHTML = html;
  }

  /* -------------------------------------------------------------
     Threshold + totals
     ------------------------------------------------------------- */
  function thresholdOffset() {
    // 0 = less sensitive (needs to be 24 dB over room), 100 = very sensitive (6 dB).
    return 24 - settings.sensitivity * 0.18;
  }

  function updateThreshold() {
    state.thresholdDb = clamp(state.floorDb + thresholdOffset(), -72, -18);
    const pct = clamp(((state.thresholdDb - DB_MIN) / (DB_MAX - DB_MIN)) * 100, 2, 98);
    els.thresholdMark.style.left = `${pct}%`;
    els.gateLabel.textContent = `gate ${formatDb(state.thresholdDb)}`;
  }

  function totalsAt(now) {
    let play = 0;
    let rest = 0;
    for (const seg of state.segments) {
      if (seg.type === 'play') play += seg.ms;
      else rest += seg.ms;
    }
    if (state.mode === 'listening' && state.phase) {
      const current = Math.max(0, now - state.phaseStart);
      if (state.phase === 'play') play += current;
      else rest += current;
    }
    return { play, rest, total: play + rest };
  }

  function displayDuration(now) {
    if (state.mode === 'listening' && state.phase) {
      return Math.max(0, now - state.phaseStart);
    }
    if (state.mode === 'paused' || state.mode === 'error') {
      return state.pausedDuration || 0;
    }
    if (state.mode === 'calibrating') {
      return state.cal && state.cal.returnMode === 'paused' ? state.pausedDuration || 0 : 0;
    }
    return 0;
  }

  function currentTone() {
    if (state.mode === 'listening' && state.phase) return state.phase;
    if (state.mode === 'starting' || state.mode === 'calibrating') return 'calm';
    if (state.mode === 'error') return 'error';
    return 'neutral';
  }

  function statusLabel() {
    if (state.mode === 'listening') {
      if (state.phase === 'play') return 'Playing';
      if (state.phase === 'rest') return 'Resting';
      return 'Listening';
    }
    switch (state.mode) {
      case 'starting': return 'Connecting';
      case 'calibrating': return 'Calibrating';
      case 'paused': return 'Paused';
      case 'error': return 'Mic issue';
      default: return 'Mic off';
    }
  }

  function phaseLabel() {
    if (state.mode === 'listening') {
      if (state.phase === 'play') return 'Playing';
      if (state.phase === 'rest') return 'Resting';
      return 'Ready';
    }
    if (state.mode === 'starting') return 'Connecting';
    if (state.mode === 'calibrating') return 'Calibrating';
    if (state.mode === 'paused') return 'Paused';
    if (state.mode === 'error') return 'Mic issue';
    return 'Not listening';
  }

  function hintText() {
    if (state.mode === 'idle') {
      return 'Press start, then play your flute. The clock follows the sound and splits your play and rest into laps.';
    }
    if (state.mode === 'starting') return 'Connecting to your microphone…';
    if (state.mode === 'calibrating') {
      return 'Stay quiet for a moment while I measure the room. The timer starts with your first note.';
    }
    if (state.mode === 'error') return state.errorMessage || 'The microphone could not start. Please try again.';
    if (state.mode === 'paused') {
      return 'Paused. Resume whenever you are ready — the next lap starts with your next note.';
    }
    if (!state.phase) {
      return 'Listening for your first note. Play whenever you are ready.';
    }
    if (state.phase === 'play') {
      return `Playing. Rest begins after ${formatDelay(settings.restDelay)} of silence, so short note gaps stay in this lap.`;
    }
    return 'Resting. Play to begin the next lap.';
  }

  function primarySpec() {
    if (state.mode === 'starting') {
      return { label: 'Connecting…', icon: 'spinner', disabled: true };
    }
    if (state.mode === 'calibrating') {
      return { label: 'Calibrating…', icon: 'spinner', disabled: true };
    }
    if (state.mode === 'paused') {
      return { label: 'Resume', icon: 'play', disabled: false };
    }
    if (state.mode === 'listening') {
      return { label: 'Pause', icon: 'pause', disabled: false, pause: true };
    }
    if (state.mode === 'error') {
      return {
        label: state.sessionStarted ? 'Resume' : 'Try again',
        icon: state.sessionStarted ? 'play' : 'retry',
        disabled: false,
      };
    }
    return { label: 'Start listening', icon: 'mic', disabled: false };
  }

  /* -------------------------------------------------------------
     Render
     ------------------------------------------------------------- */
  function renderStatus() {
    const tone = currentTone();
    els.timerCard.dataset.tone = tone;
    document.body.dataset.mode = state.mode;
    if (state.phase) document.body.dataset.phase = state.phase;
    else delete document.body.dataset.phase;

    els.statusPill.dataset.state = state.mode === 'listening' && state.phase ? state.phase : state.mode;
    setText(els.statusText, statusLabel());

    els.phasePill.dataset.tone = tone;
    setText(els.phaseText, phaseLabel());

    let eyebrow = 'Current lap';
    let index = '—';
    if (state.mode === 'paused' || (state.mode === 'error' && state.segments.length)) {
      eyebrow = 'Last lap';
      if (state.segments.length) index = pad2(state.segments.length);
    } else if (state.mode === 'listening' && state.phase) {
      index = pad2(state.segments.length + 1);
    } else if (state.mode === 'error' && !state.segments.length) {
      eyebrow = 'Timer';
    }
    setText(els.lapEyebrow, eyebrow);
    setText(els.lapIndex, index);

    const hint = hintText();
    setText(els.hint, hint);
    els.hint.classList.toggle('is-error', state.mode === 'error');
  }

  function renderTimer(now) {
    const ms = displayDuration(now);
    const parts = splitTime(ms);
    setText(els.timeMain, parts.main);
    setText(els.timeTenths, parts.tenths);

    const idleLook = !(
      (state.mode === 'listening' && state.phase) ||
      (state.mode === 'paused' && state.pausedDuration) ||
      state.segments.length
    );
    els.bigTime.classList.toggle('is-idle', idleLook);

    const ariaKey = `${state.mode}|${state.phase || ''}|${Math.floor(ms / 1000)}`;
    if (ariaKey !== state.lastAriaTimer) {
      state.lastAriaTimer = ariaKey;
      const label = state.mode === 'listening' && state.phase
        ? `${state.phase === 'play' ? 'Playing' : 'Resting'} lap, ${formatTimeLong(ms)}`
        : state.mode === 'paused'
          ? `Paused, last lap ${formatTimeLong(state.pausedDuration)}`
          : 'Timer, zero';
      els.bigTime.setAttribute('aria-label', label);
    }
  }

  function renderStats(now) {
    const totals = totalsAt(now);
    setText(els.playTotal, formatTime(totals.play, false));
    setText(els.restTotal, formatTime(totals.rest, false));
    setText(els.sessionTotal, formatTime(totals.total, false));

    const pct = totals.total > 0 ? (totals.play / totals.total) * 100 : 0;
    els.ratioPlay.style.width = `${pct}%`;
    els.ratioRest.style.width = `${totals.total > 0 ? 100 - pct : 0}%`;
    els.ratio.classList.toggle('is-empty', totals.total === 0);
  }

  function renderMeter(now) {
    const audioOn = Boolean(state.audio);
    els.meterTrack.classList.toggle('is-off', !audioOn);
    els.meterTrack.classList.toggle('is-calibrating', Boolean(state.cal));

    let stateText = 'Mic off';
    let signal = false;
    let calibrating = false;

    if (state.mode === 'starting') {
      stateText = 'Connecting';
    } else if (state.mode === 'calibrating') {
      stateText = 'Measuring';
      calibrating = true;
    } else if (audioOn) {      const db = state.smoothDb ?? -100;
      signal = db >= state.thresholdDb;
      stateText = signal ? 'Sound' : 'Quiet';
    } else if (state.mode === 'error') {
      stateText = 'No signal';
    }

    setText(els.meterState, stateText);
    els.meterState.classList.toggle('is-signal', signal);
    els.meterState.classList.toggle('is-calibrating', calibrating);
    els.meterTrack.classList.toggle('is-above', signal);

    if (audioOn) {
      const level = state.smoothDb ?? DB_MIN;
      const pct = clamp(((level - DB_MIN) / (DB_MAX - DB_MIN)) * 100, 0, 100);
      els.meterFill.style.width = `${pct.toFixed(1)}%`;
    } else {
      els.meterFill.style.width = '0%';
    }

    if (state.cal) {
      const progress = clamp((now - state.cal.startedAt) / state.cal.duration, 0, 1);
      els.meterTrack.style.setProperty('--cal-progress', `${(progress * 100).toFixed(1)}%`);
    } else {
      els.meterTrack.style.setProperty('--cal-progress', '0%');
    }

    if (state.cal) {
      setText(els.meterCal, 'measuring room');
    } else if (settings.floorDb != null) {
      setText(els.meterCal, `room ${formatDb(state.floorDb)}`);
    } else {
      setText(els.meterCal, 'room level not set');
    }
  }

  function avgLapText(type) {
    const laps = state.segments.filter((seg) => seg.type === type);
    if (!laps.length) return '—';
    return formatTime(laps.reduce((sum, seg) => sum + seg.ms, 0) / laps.length, false);
  }

  function renderLaps() {
    const completed = state.segments.length;
    const current = state.mode === 'listening' && state.phase;
    const counts = { play: 0, rest: 0 };
    for (const seg of state.segments) counts[seg.type] += 1;

    let html = '';
    if (current) {
      counts[state.phase] += 1;
      html += `
        <li class="lap-row current ${state.phase}" id="currentLapRow">
          <span class="lap-no">${pad2(completed + 1)}</span>
          <span class="lap-kind"><span class="dot" aria-hidden="true"></span>${state.phase === 'play' ? 'Play' : 'Rest'}</span>
          <span class="lap-time" id="currentLapTime">${formatTime(Math.max(0, performance.now() - state.phaseStart))}</span>
        </li>`;
    }

    for (let i = completed - 1; i >= 0; i -= 1) {
      const seg = state.segments[i];
      const num = i + 1;
      const isNew = num === state.lastAddedLap && performance.now() - state.lastAddedAt < 1400;
      html += `
        <li class="lap-row ${seg.type}${isNew ? ' is-new' : ''}">
          <span class="lap-no">${pad2(num)}</span>
          <span class="lap-kind"><span class="dot" aria-hidden="true"></span>${seg.type === 'play' ? 'Play' : 'Rest'}</span>
          <span class="lap-time">${formatTime(seg.ms)}</span>
        </li>`;
    }

    if (!html) {
      html = `
        <li class="lap-empty">
          <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
          <p>No laps yet</p>
          <span>${state.mode === 'listening' ? 'Waiting for your first note.' : 'Play a note and the first lap starts on its own.'}</span>
        </li>`;
    }

    els.lapList.innerHTML = html;
    els.lapList.scrollTop = 0;
    state.currentTimeEl = $('currentLapTime');

    setText(els.lapCounts, `${counts.play} play · ${counts.rest} rest`);

    if (completed) {
      const parts = [];
      if (counts.play) parts.push(`Avg play ${avgLapText('play')}`);
      if (counts.rest) parts.push(`Avg rest ${avgLapText('rest')}`);
      setText(els.lapFoot, parts.join(' · '));
    } else {
      setText(els.lapFoot, 'Laps split automatically as you alternate.');
    }
    state.lastLapRenderAt = performance.now();
  }

  function renderLapTick(now) {
    if (state.currentTimeEl && state.mode === 'listening' && state.phase) {
      setText(state.currentTimeEl, formatTime(Math.max(0, now - state.phaseStart)));
    }
  }

  function renderControls() {
    const spec = primarySpec();
    setText(els.primaryLabel, spec.label);
    setHTML(els.primaryIcon, ICONS[spec.icon], spec.icon);
    els.primaryBtn.disabled = Boolean(spec.disabled);
    els.primaryBtn.classList.toggle('is-pause', Boolean(spec.pause));

    const hasData = state.segments.length > 0 || state.sessionStarted;
    const canReset = hasData || state.mode !== 'idle';
    els.resetBtn.disabled = !canReset;
    const armed = state.resetArmedAt > 0;
    setText(els.resetBtn, armed ? 'Confirm reset' : 'Reset');
    els.resetBtn.classList.toggle('is-armed', armed);

    const busy = state.mode === 'starting' || state.mode === 'calibrating';
    const activeLap = state.mode === 'listening' && Boolean(state.phase);
    els.calibrateBtn.disabled = busy || activeLap || state.mode === 'error';
    setText(els.calibrateBtn, state.cal ? 'Calibrating…' : 'Calibrate room');
    els.calibrateBtn.title = activeLap
      ? 'Pause the timer before recalibrating.'
      : state.mode === 'error'
        ? 'Fix microphone access first.'
        : 'Measure the room level for two quiet seconds.';

    if (state.cal) {
      const remaining = Math.max(0, state.cal.duration - (performance.now() - state.cal.startedAt)) / 1000;
      setText(els.calibrateNote, `${remaining.toFixed(1)}s — stay quiet.`);
    } else if (state.bgCal) {
      setText(els.calibrateNote, 'Measuring room tone…');
    } else if (settings.floorDb != null) {
      setText(els.calibrateNote, `Room floor ${formatDb(settings.floorDb)} · ${relativeCalibration(settings.calibratedAt)}.`);
    } else if (state.mode === 'listening') {
      setText(els.calibrateNote, 'Listening with the default room level. Calibrate if the gate feels wrong.');
    } else {
      setText(els.calibrateNote, 'Two quiet seconds tunes the room level.');
    }
  }

  function render(now = performance.now()) {
    renderStatus();
    renderTimer(now);
    renderStats(now);
    renderMeter(now);
    renderLapTick(now);
    renderControls();
  }

  function announce(text) {
    if (!els.liveRegion) return;
    els.liveRegion.textContent = '';
    window.setTimeout(() => {
      els.liveRegion.textContent = text;
    }, 30);
  }

  function showToast(text, duration = 2800) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = text;
    els.toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, duration);
  }

  function setMode(mode) {
    state.mode = mode;
    render();
  }

  /* -------------------------------------------------------------
     Microphone + detection
     ------------------------------------------------------------- */
  function isMicActive() {
    return Boolean(state.audio);
  }

  function resetDetection() {
    state.above = false;
    state.aboveSince = null;
    state.lastAbove = null;
    state.smoothDb = null;
  }

  function cleanMicLabel(label) {
    const original = label || '';
    let cleaned = original
      .replace(/^Default\s*[-–—]\s*/i, '')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim();
    if (!cleaned) cleaned = 'Microphone on';
    if (/macbook/i.test(cleaned)) return 'MacBook microphone';
    if (/iphone/i.test(cleaned)) return 'iPhone microphone';
    if (/airpods/i.test(cleaned)) return 'AirPods microphone';
    return cleaned;
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || !state.audio || document.visibilityState !== 'visible') return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } catch {
      /* wake lock is a nicety, not a requirement */
    }
  }

  function releaseWakeLock() {
    if (!state.wakeLock) return;
    try {
      state.wakeLock.release();
    } catch {
      /* already gone */
    }
    state.wakeLock = null;
  }

  async function acquireAudio() {
    if (state.audio) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const error = new Error('getUserMedia unavailable');
      error.name = 'SecurityError';
      throw error;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'TypeError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw err;
      }
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      const error = new Error('Web Audio unavailable');
      error.name = 'NotSupportedError';
      throw error;
    }

    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* resumed by the click that got us here */ }
    }

    const source = ctx.createMediaStreamSource(stream);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 180;
    highpass.Q.value = 0.7;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 7000;
    lowpass.Q.value = 0.7;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      try { await ctx.close(); } catch { /* noop */ }
      const error = new Error('No audio track');
      error.name = 'NotFoundError';
      throw error;
    }

    track.addEventListener('ended', handleTrackEnded);
    state.audio = {
      stream,
      ctx,
      source,
      highpass,
      lowpass,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      track,
    };
    state.lastFrameTs = 0;
    state.smoothDb = null;

    const label = cleanMicLabel(track.label);
    setText(els.micName, label);
    els.micName.title = track.label || label;
    requestWakeLock();
    return true;
  }

  function stopAudio() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    const audio = state.audio;
    state.audio = null;
    state.bgCal = null;
    resetDetection();
    if (audio) {
      try { audio.track.removeEventListener('ended', handleTrackEnded); } catch { /* noop */ }
      try { audio.stream.getTracks().forEach((track) => track.stop()); } catch { /* noop */ }
      try { audio.ctx.close(); } catch { /* noop */ }
    }
    releaseWakeLock();
    setText(els.micName, 'Microphone off');
    els.micName.removeAttribute('title');
  }

  function handleTrackEnded() {
    const now = performance.now();
    const wasRunning = state.mode === 'listening';
    if (wasRunning) {
      finalizeCurrent(now);
    }
    const hadSession = state.sessionStarted || state.segments.length > 0;
    stopAudio();
    state.cal = null;
    if (state.phase) {
      state.pausedPhase = state.phase;
      state.phase = null;
    }
    state.errorMessage = hadSession
      ? 'The microphone disconnected. Resume when it is back, or reset to start over.'
      : 'The microphone disconnected. Reconnect it, then try again.';
    state.mode = 'error';
    render();
    renderLaps();
  }

  function startLoop() {
    if (state.rafId) return;
    state.lastFrameTs = 0;
    state.rafId = requestAnimationFrame(audioLoop);
  }

  function readLevel(dt) {
    const audio = state.audio;
    if (!audio) return;
    const buffer = audio.buffer;
    audio.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const value = buffer[i];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / buffer.length);
    const db = 20 * Math.log10(Math.max(rms, 0.0000001));
    state.rawDb = clamp(db, -100, 0);

    if (state.smoothDb == null) {
      state.smoothDb = state.rawDb;
      return;
    }
    const rising = state.rawDb > state.smoothDb;
    const tau = rising ? 0.045 : 0.11;
    const alpha = 1 - Math.exp(-Math.max(0.001, Math.min(0.12, dt)) / tau);
    state.smoothDb += (state.rawDb - state.smoothDb) * alpha;
  }

  function audioLoop(timestamp) {
    if (!state.audio) {
      state.rafId = 0;
      return;
    }
    state.rafId = requestAnimationFrame(audioLoop);
    const dt = state.lastFrameTs ? (timestamp - state.lastFrameTs) / 1000 : 1 / 60;
    state.lastFrameTs = timestamp;
    readLevel(dt);

    if (state.bgCal) {
      updateBackgroundCalibration(timestamp);
    }
    if (state.cal) {
      updateCalibration(timestamp);
    } else if (state.mode === 'listening') {
      detect(timestamp);
    }
    render(timestamp);
  }

  function startSession(startAt) {
    state.sessionStarted = true;
    state.bgCal = null;
    state.phase = 'play';
    state.phaseStart = startAt;
    state.pausedDuration = 0;
    state.lastAbove = performance.now();
    state.aboveSince = startAt;
    if (state.mode !== 'listening') setMode('listening');
    renderLaps();
    render();
  }

  function pushSegment(type, ms) {
    state.segments.push({ type, ms: Math.max(0, ms) });
    state.lastAddedLap = state.segments.length;
    state.lastAddedAt = performance.now();
    renderLaps();
    const label = type === 'play' ? 'Play' : 'Rest';
    announce(`Lap ${state.segments.length}, ${label}, ${formatTimeLong(ms)}.`);
  }

  function finalizeCurrent(now) {
    if (!state.phase) return 0;
    const duration = Math.max(0, now - state.phaseStart);
    const previous = state.phase;
    state.phase = null;
    state.above = false;
    state.aboveSince = null;
    state.lastAbove = null;
    state.pausedPhase = previous;
    if (duration >= MIN_SEGMENT_MS) {
      state.pausedDuration = duration;
      pushSegment(previous, duration);
    } else {
      state.pausedDuration = 0;
    }
    return duration;
  }

  function detect(now) {
    const opening = state.thresholdDb;
    const closing = state.thresholdDb - 3;
    const crossed = state.smoothDb >= (state.above ? closing : opening);

    state.above = crossed;
    if (crossed) {
      if (state.aboveSince == null) state.aboveSince = now;
      state.lastAbove = now;
    } else {
      state.aboveSince = null;
    }

    if (!state.sessionStarted) {
      if (crossed && state.aboveSince != null && now - state.aboveSince >= settings.onsetDelay * 1000) {
        startSession(state.aboveSince);
      }
      return;
    }

    if (state.phase === 'play') {
      if (!crossed && state.lastAbove != null && now - state.lastAbove >= settings.restDelay * 1000) {
        transitionTo('rest', state.lastAbove, now);
      }
      return;
    }

    if (state.phase === 'rest') {
      if (crossed && state.aboveSince != null && now - state.aboveSince >= settings.onsetDelay * 1000) {
        transitionTo('play', state.aboveSince, now);
      }
    }
  }

  function transitionTo(next, boundary, now) {
    const previous = state.phase;
    if (!previous) return;
    const duration = Math.max(0, boundary - state.phaseStart);
    if (duration >= MIN_SEGMENT_MS) {
      pushSegment(previous, duration);
    }
    state.phase = next;
    state.phaseStart = boundary;
    state.pausedDuration = 0;
    if (next === 'play') {
      state.lastAbove = now;
      state.aboveSince = state.aboveSince ?? now;
    } else {
      state.lastAbove = boundary;
      state.aboveSince = null;
    }
    renderLaps();
    render();
    announce(next === 'play' ? 'Playing. New lap.' : 'Resting. Lap complete.');
  }

  /* -------------------------------------------------------------
     Calibration
     ------------------------------------------------------------- */
  function floorIsFresh() {
    return settings.floorDb != null
      && settings.calibratedAt > 0
      && Date.now() - settings.calibratedAt < FLOOR_TTL_MS;
  }

  function updateBackgroundCalibration(now) {
    const bg = state.bgCal;
    if (!bg) return;
    const elapsed = now - bg.startedAt;
    if (elapsed >= 60 && state.rawDb > BG_SILENCE_DB) bg.samples.push(state.rawDb);

    if (
      state.sessionStarted
      || state.above
      || (state.smoothDb != null && state.smoothDb >= state.thresholdDb)
    ) {
      bg.contaminated = true;
    }

    if (elapsed < bg.duration) return;
    state.bgCal = null;

    if (bg.contaminated || bg.samples.length < BG_MIN_SAMPLES) {
      renderControls();
      return;
    }

    const sorted = bg.samples.slice().sort((a, b) => a - b);
    const measured = percentile(sorted, 0.22);
    if (measured == null) return;

    // If sound returned in the final frames, keep the previous gate.
    if (state.smoothDb != null && state.smoothDb >= state.thresholdDb) return;

    const floor = clamp(Math.round(measured), -82, -30);
    settings.floorDb = floor;
    settings.calibratedAt = Date.now();
    saveSettings();
    state.floorDb = floor;
    updateThreshold();
    render();
  }

  function beginCalibration({ duration = 2000, returnMode = 'listening', purpose = 'manual', temp = false }) {
    state.bgCal = null;
    state.cal = {
      startedAt: performance.now(),
      duration,
      samples: [],
      returnMode,
      purpose,
      temp,
    };
    resetDetection();
    state.mode = 'calibrating';
    render();
  }

  function updateCalibration(now) {
    const cal = state.cal;
    if (!cal) return;
    const elapsed = now - cal.startedAt;
    if (elapsed >= 70 && cal.samples.length < 2400) {
      cal.samples.push(state.rawDb);
    }
    if (elapsed >= cal.duration && cal.samples.length >= 6) {
      finishCalibration(cal);
    }
  }

  function percentile(sorted, fraction) {
    if (!sorted.length) return null;
    const index = clamp(Math.floor((sorted.length - 1) * fraction), 0, sorted.length - 1);
    return sorted[index];
  }

  function finishCalibration(cal) {
    if (state.cal !== cal) return;
    const samples = cal.samples.slice().sort((a, b) => a - b);
    const measured = percentile(samples, 0.22);
    const previous = settings.floorDb;
    let floor = measured == null ? (previous ?? -68) : measured;

    // Protect against calibrating while the flute is sounding.
    if (floor > -28) {
      floor = previous ?? -62;
      showToast('That sounded loud — keeping the previous room level.');
    }
    floor = clamp(Math.round(floor), -82, -30);

    settings.floorDb = floor;
    settings.calibratedAt = Date.now();
    saveSettings();
    state.floorDb = floor;
    state.cal = null;
    updateThreshold();
    resetDetection();

    const wasTemp = cal.temp || cal.returnMode !== 'listening';
    if (wasTemp) {
      stopAudio();
      state.mode = cal.returnMode === 'paused' ? 'paused' : 'idle';
      showToast(`Room calibrated · gate at ${formatDb(state.thresholdDb)}.`);
    } else {
      state.mode = 'listening';
      state.lastAriaTimer = '';
      if (cal.purpose === 'manual') {
        showToast(`Room calibrated · gate at ${formatDb(state.thresholdDb)}.`);
      }
    }

    render();
    renderLaps();
  }

  function abortCalibration() {
    const cal = state.cal;
    state.cal = null;
    resetDetection();
    if (!cal) return;
    if (cal.temp || cal.returnMode !== 'listening') {
      stopAudio();
      state.mode = cal.returnMode === 'paused' ? 'paused' : 'idle';
    } else {
      state.mode = 'listening';
    }
    render();
  }

  async function calibrateManually() {
    if (state.cal || state.mode === 'starting') return;
    if (state.mode === 'listening' && state.phase) {
      showToast('Pause the timer before recalibrating.');
      return;
    }
    if (state.mode === 'listening') {
      beginCalibration({ duration: 2000, returnMode: 'listening', purpose: 'manual' });
      return;
    }
    if (state.mode === 'error') {
      showToast('Fix microphone access first.');
      return;
    }
    if (!['idle', 'paused'].includes(state.mode)) return;

    const returnMode = state.mode === 'paused' ? 'paused' : 'idle';
    const token = ++state.opToken;
    state.mode = 'starting';
    render();
    try {
      await acquireAudio();
      if (token !== state.opToken) {
        stopAudio();
        return;
      }
      startLoop();
      beginCalibration({ duration: 2000, returnMode, purpose: 'manual', temp: true });
    } catch (err) {
      if (token !== state.opToken) return;
      stopAudio();
      if (returnMode === 'paused') {
        state.mode = 'paused';
        showToast(micErrorMessage(err), 4200);
        render();
      } else {
        handleMicError(err);
      }
    }
  }

  function micErrorMessage(err) {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      return 'Microphone access needs localhost or HTTPS. Open the app with the included start script rather than the HTML file directly.';
    }
    const name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone access is blocked. Allow it for this site in your browser’s address bar, then try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect one, then try again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The microphone is busy in another app. Close that app, then try again.';
    }
    if (name === 'SecurityError') {
      return 'Microphone access needs a local server. Open the app with the included start script rather than the HTML file directly.';
    }
    return `The microphone could not start${name ? ` (${name})` : ''}. Check your system sound settings and try again.`;
  }

  function handleMicError(err) {
    stopAudio();
    state.errorMessage = micErrorMessage(err);
    state.mode = 'error';
    render();
    renderLaps();
  }



  /* -------------------------------------------------------------
     Actions
     ------------------------------------------------------------- */
  function clearSessionState() {
    state.phase = null;
    state.phaseStart = 0;
    state.sessionStarted = false;
    state.segments = [];
    state.pausedDuration = 0;
    state.pausedPhase = null;
    state.bgCal = null;
    state.lastAddedLap = 0;
    state.lastAddedAt = 0;
    state.currentTimeEl = null;
    state.lastAriaTimer = '';
    state.above = false;
    state.aboveSince = null;
    state.lastAbove = null;
    state.resetArmedAt = 0;
    clearTimeout(state.resetTimer);
  }

  async function startListening() {
    if (state.mode === 'starting' || state.mode === 'calibrating' || state.mode === 'listening') return;
    if (state.sessionStarted) {
      resumeListening();
      return;
    }
    disarmReset();
    const token = ++state.opToken;
    clearSessionState();
    state.cal = null;
    state.errorMessage = '';
    state.floorDb = settings.floorDb ?? -68;
    updateThreshold();
    state.mode = 'starting';
    render();
    renderLaps();

    try {
      await acquireAudio();
      if (token !== state.opToken) {
        stopAudio();
        return;
      }
      startLoop();
      state.floorDb = settings.floorDb ?? -68;
      updateThreshold();
      resetDetection();
      state.bgCal = settings.floorDb != null && floorIsFresh()
        ? null
        : {
            startedAt: performance.now(),
            duration: 900,
            samples: [],
            contaminated: false,
          };
      state.mode = 'listening';
      render();
      renderLaps();
    } catch (err) {
      if (token !== state.opToken) return;
      handleMicError(err);
    }
  }

  function pauseListening() {
    if (state.mode !== 'listening') return;
    const now = performance.now();
    if (state.phase) finalizeCurrent(now);
    const hadSession = state.sessionStarted || state.segments.length > 0;
    stopAudio();
    state.cal = null;

    if (!hadSession) {
      clearSessionState();
      state.mode = 'idle';
      renderLaps();
      render();
      return;
    }

    state.mode = 'paused';
    renderLaps();
    render();
  }

  async function resumeListening() {
    if (!['paused', 'error'].includes(state.mode)) return;
    if (!state.sessionStarted) {
      startListening();
      return;
    }
    disarmReset();
    const token = ++state.opToken;
    state.errorMessage = '';
    state.mode = 'starting';
    render();

    try {
      await acquireAudio();
      if (token !== state.opToken) {
        stopAudio();
        return;
      }
      startLoop();
      state.floorDb = settings.floorDb ?? state.floorDb;
      updateThreshold();
      resetDetection();
      state.phase = 'rest';
      state.phaseStart = performance.now();
      state.pausedDuration = 0;
      state.pausedPhase = null;
      state.mode = 'listening';
      renderLaps();
      render();
    } catch (err) {
      if (token !== state.opToken) return;
      handleMicError(err);
    }
  }

  function primaryAction() {
    disarmReset();
    switch (state.mode) {
      case 'idle':
        startListening();
        break;
      case 'error':
        if (state.sessionStarted) resumeListening();
        else startListening();
        break;
      case 'listening':
        pauseListening();
        break;
      case 'paused':
        resumeListening();
        break;
      default:
        break;
    }
  }

  function disarmReset() {
    if (!state.resetArmedAt) return;
    state.resetArmedAt = 0;
    clearTimeout(state.resetTimer);
    renderControls();
  }

  function armReset() {
    state.resetArmedAt = performance.now();
    clearTimeout(state.resetTimer);
    renderControls();
    state.resetTimer = window.setTimeout(() => {
      if (!state.resetArmedAt) return;
      state.resetArmedAt = 0;
      renderControls();
    }, 3200);
  }

  function performReset() {
    state.opToken += 1;
    state.resetArmedAt = 0;
    clearTimeout(state.resetTimer);
    state.cal = null;
    stopAudio();
    clearSessionState();
    state.errorMessage = '';
    state.mode = 'idle';
    state.pausedDuration = 0;
    renderLaps();
    render();
    announce('Session cleared.');
    showToast('Session cleared.');
  }

  function requestReset() {
    if (els.resetBtn.disabled) return;
    const needsConfirm = state.segments.length > 0 || state.sessionStarted;
    if (needsConfirm && !state.resetArmedAt) {
      armReset();
      return;
    }
    performReset();
  }

  /* -------------------------------------------------------------
     Settings wiring
     ------------------------------------------------------------- */
  function paintRange(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--pct', `${clamp(pct, 0, 100)}%`);
  }

  function syncSettingsUI() {
    els.sensitivity.value = String(settings.sensitivity);
    els.restDelay.value = String(settings.restDelay);
    els.onsetDelay.value = String(settings.onsetDelay);
    paintRange(els.sensitivity);
    paintRange(els.restDelay);
    paintRange(els.onsetDelay);
    setText(els.sensitivityValue, sensitivityWord(settings.sensitivity));
    setText(els.restDelayValue, formatDelay(settings.restDelay));
    setText(els.onsetDelayValue, `${settings.onsetDelay.toFixed(2)}s`);
  }

  function onSensitivityInput() {
    settings.sensitivity = clamp(Number(els.sensitivity.value), 0, 100);
    saveSettings();
    paintRange(els.sensitivity);
    setText(els.sensitivityValue, sensitivityWord(settings.sensitivity));
    updateThreshold();
    render();
  }

  function onRestDelayInput() {
    settings.restDelay = clamp(Number(els.restDelay.value), 0.4, 2);
    saveSettings();
    paintRange(els.restDelay);
    setText(els.restDelayValue, formatDelay(settings.restDelay));
    render();
  }

  function onOnsetDelayInput() {
    settings.onsetDelay = clamp(Number(els.onsetDelay.value), 0.05, 0.5);
    saveSettings();
    paintRange(els.onsetDelay);
    setText(els.onsetDelayValue, `${settings.onsetDelay.toFixed(2)}s`);
    render();
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function isInteractiveTarget(target) {
    if (!target) return true;
    return Boolean(target.closest('button, a, summary, input, textarea, select, [contenteditable="true"]'));
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Space') {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      if (!els.primaryBtn.disabled) primaryAction();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      if (isInteractiveTarget(event.target) && event.target.tagName !== 'BODY') return;
      event.preventDefault();
      requestReset();
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      if (state.audio) {
        if (state.audio.ctx.state === 'suspended') state.audio.ctx.resume().catch(() => {});
        requestWakeLock();
      }
      render();
    }
  }

  function init() {
    state.floorDb = settings.floorDb ?? state.floorDb;
    updateThreshold();
    syncSettingsUI();
    renderLaps();
    render();

    els.primaryBtn.addEventListener('click', primaryAction);
    els.resetBtn.addEventListener('click', requestReset);
    els.calibrateBtn.addEventListener('click', () => {
      disarmReset();
      calibrateManually();
    });
    els.sensitivity.addEventListener('input', onSensitivityInput);
    els.restDelay.addEventListener('input', onRestDelayInput);
    els.onsetDelay.addEventListener('input', onOnsetDelayInput);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibilityChange);

    window.addEventListener('pagehide', () => {
      stopAudio();
    });

    // Read-only snapshot for debugging and automated checks.
    window.fluteTimer = Object.freeze({
      snapshot: () => ({
        mode: state.mode,
        phase: state.phase,
        sessionStarted: state.sessionStarted,
        segments: state.segments.map((seg) => ({ type: seg.type, ms: Math.round(seg.ms) })),
        pausedDuration: Math.round(state.pausedDuration),
        floorDb: state.floorDb,
        thresholdDb: state.thresholdDb,
        calibratedAt: settings.calibratedAt,
        audio: Boolean(state.audio),
        rawDb: Math.round(state.rawDb * 10) / 10,
        smoothDb: state.smoothDb == null ? null : Math.round(state.smoothDb * 10) / 10,
        above: state.above,
      }),
    });
  }



  init();
})();
