(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $('waveCanvas');
  const ctx = canvas.getContext('2d');
  const state = {
    type: 'ultimate', playing: false, volume: 0.65,
    low: 0.75, mid: 0.55, high: 0.30,
    metronomeEnabled: false, bpm: 60, silenceMs: 120,
    timer: { enabled: false, minutes: 5, glide: false, startBpm: 60, endBpm: 30, curve: 'linear', endAction: 'fade', fadeOut: 10 },
    session: { elapsed: 0, bpm: null, done: false }
  };
  const baseTitle = document.title;
  const track = (name) => { if (window.bsTrack) window.bsTrack(name); };
  const curveDescriptions = {
    linear: 'The same change in BPM every minute.',
    smooth: 'Starts and ends gently, changes fastest in the middle.',
    exponential: 'The same percentage change every minute. Often feels the most even.'
  };
  let audioContext = null;
  let masterGain = null;
  let workletNode = null;
  let animationFrame = 0;
  let phase = 0;
  let lastWave = new Float32Array(256);
  const profiles = {
    ultimate: ['Ultimate White Noise', 'Adjustable multi-band noise'],
    white: ['White noise', 'Even, bright broadband noise'],
    pink: ['Pink noise', 'Softer noise with emphasis on low frequencies'],
    brown: ['Brown noise', 'Deep, low-frequency rumble']
  };

  async function createAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.AudioWorkletNode) {
      $('statusText').textContent = 'AUDIOWORKLET NOT SUPPORTED';
      return false;
    }

    // audioWorklet is an instance getter. Accessing it through
    // AudioContext.prototype can throw TypeError: Illegal invocation.
    audioContext = new AudioContextClass();
    if (!audioContext.audioWorklet) {
      $('statusText').textContent = 'AUDIOWORKLET NOT SUPPORTED';
      await audioContext.close();
      audioContext = null;
      return false;
    }

    try {
      await audioContext.audioWorklet.addModule('noise-processor.js');
      workletNode = new AudioWorkletNode(audioContext, 'noise-processor', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]
      });
      masterGain = audioContext.createGain();
      masterGain.gain.value = 0;
      workletNode.connect(masterGain);
      masterGain.connect(audioContext.destination);
      setParam('low', state.low, 0.025);
      setParam('mid', state.mid, 0.025);
      setParam('high', state.high, 0.025);
      setParam('bpm', state.bpm, 0.01);
      setParam('silenceMs', state.silenceMs, 0.01);
      setParam('metroEnabled', state.metronomeEnabled ? 1 : 0, 0.01);
      sendSession();
      workletNode.port.onmessage = (event) => {
        const data = event.data || {};
        if (data.wave) lastWave.set(data.wave.slice(0, lastWave.length));
        if (data.session) onSessionTick(data.session);
        if (data.ended) onSessionEnded(data.action);
      };
      return true;
    } catch (error) {
      console.error('AudioWorklet initialization failed:', error);
      $('statusText').textContent = 'AUDIOWORKLET FAILED TO START';
      return false;
    }
  }

  function setParam(name, value, timeConstant = 0.03) {
    if (!workletNode || !audioContext) return;
    const param = workletNode.parameters.get(name);
    if (!param) return;
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, timeConstant);
  }

  async function play() {
    if (!audioContext && !(await createAudio())) return;
    try {
      await audioContext.resume();
      if (state.timer.enabled && state.session.done) resetSession();
      workletNode.port.postMessage({ type: 'start' });
      masterGain.gain.cancelScheduledValues(audioContext.currentTime);
      masterGain.gain.setTargetAtTime(state.volume, audioContext.currentTime, 0.025);
      state.playing = true;
      track('play');
      document.body.classList.add('is-playing');
      $('statusText').textContent = 'PLAYING';
      $('visualizerState').textContent = 'LIVE AUDIO · AUDIOWORKLET';
      $('playButton').setAttribute('aria-label', 'Pause');
      $('playIcon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
      if (!animationFrame) draw();
    } catch (error) {
      $('statusText').textContent = 'COULD NOT START AUDIO';
      console.error(error);
    }
  }

  async function stop() {
    state.playing = false;
    document.title = baseTitle;
    document.body.classList.remove('is-playing');
    $('statusText').textContent = 'PAUSED';
    $('visualizerState').textContent = 'PAUSED';
    $('playButton').setAttribute('aria-label', 'Play');
    $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (audioContext && masterGain) {
      masterGain.gain.cancelScheduledValues(audioContext.currentTime);
      masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.02);
      window.setTimeout(() => {
        if (!state.playing && audioContext && audioContext.state === 'running') audioContext.suspend();
      }, 120);
    }
    drawStatic();
  }

  function setType(type) {
    if (!profiles[type]) return;
    state.type = type;
    $('currentNoise').textContent = profiles[type][0];
    $('trackDescription').textContent = profiles[type][1];
    document.querySelectorAll('.profile-card').forEach((card) => {
      const active = card.dataset.type === type;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    if (workletNode) workletNode.port.postMessage({ type: 'setType', value: type });
  }

  function updateRange(id, key, outputId) {
    state[key] = Number($(id).value) / 100;
    $(outputId).textContent = `${$(id).value}%`;
    setParam(key, state[key], 0.035);
  }

  const clampInt = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && String(value).trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.round(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };
  let tempoInputShowsLive = false;
  const isGlideActive = () => state.timer.enabled && state.timer.glide;
  const liveBpm = () => (isGlideActive() ? (state.session.bpm || state.timer.startBpm) : state.bpm);

  // Reads and validates the metronome inputs, then pushes them to the audio engine.
  function syncMetronomeControls() {
    const glide = isGlideActive();
    // While glide is active the input only displays the live tempo, so don't read it back
    // (also skipped on the very first sync after glide ends, when it still shows that value).
    if (!glide && !tempoInputShowsLive) state.bpm = clampInt($('bpmInput').value, 30, 240, 60);

    // Silence can never exceed one beat, so limit it by the fastest tempo in play.
    const fastest = glide ? Math.max(state.timer.startBpm, state.timer.endBpm) : state.bpm;
    const maxSilence = Math.max(0, Math.min(1000, Math.floor(60000 / fastest - 8)));
    $('silenceInput').max = maxSilence;
    $('silenceRange').max = maxSilence;
    state.silenceMs = clampInt($('silenceInput').value, 0, maxSilence, 120);
    $('silenceMaxHint').textContent = `${maxSilence} ms`;

    renderMetronome();
    setParam('bpm', state.bpm, 0.01);
    setParam('silenceMs', state.silenceMs, 0.01);
    setParam('metroEnabled', state.metronomeEnabled ? 1 : 0, 0.01);
  }

  // UI only: safe to call often (it is called while the tempo glides).
  function renderMetronome() {
    const glide = isGlideActive();
    const bpm = liveBpm();
    const shown = Math.round(bpm);
    tempoInputShowsLive = glide;
    $('bpmInput').value = shown;
    $('bpmRange').value = shown;
    ['bpmInput', 'bpmRange', 'bpmDown', 'bpmUp'].forEach((id) => { $(id).disabled = glide; });
    $('tempoLock').hidden = !glide;
    $('silenceInput').value = state.silenceMs;
    $('silenceRange').value = state.silenceMs;
    $('metronomePanel').classList.toggle('metro-enabled', state.metronomeEnabled);
    $('metronomeSummary').textContent = state.metronomeEnabled
      ? `${state.silenceMs} ms of silence · every ${Math.round(60000 / bpm)} ms (${glide ? bpm.toFixed(1) : state.bpm} BPM)`
      : 'Off — noise plays continuously';
    $('metronomeEnabled').setAttribute('aria-checked', String(state.metronomeEnabled));
  }

  function setMetronomeEnabled(enabled) {
    state.metronomeEnabled = Boolean(enabled);
    $('metronomeEnabled').checked = state.metronomeEnabled;
    if (state.metronomeEnabled && workletNode) workletNode.port.postMessage({ type: 'resetClock' });
    syncMetronomeControls();
    updateTimerSummary();
  }

  /* ---------- Session timer & tempo glide ---------- */

  const CURVE_W = 600, CURVE_H = 120, CURVE_PX = 6, CURVE_PY = 14;
  let curveMap = null;

  // Same maths as the audio engine, used for the preview and the playhead.
  function glideValue(u) {
    const { startBpm: a, endBpm: b, curve } = state.timer;
    u = Math.min(1, Math.max(0, u));
    if (curve === 'smooth') return a + (b - a) * u * u * (3 - 2 * u);
    if (curve === 'exponential') return a * Math.pow(b / a, u);
    return a + (b - a) * u;
  }

  function sendSession() {
    if (!workletNode) return;
    const t = state.timer;
    workletNode.port.postMessage({
      type: 'session',
      value: {
        enabled: t.enabled, duration: t.minutes * 60, glide: t.glide,
        startBpm: t.startBpm, endBpm: t.endBpm, curve: t.curve,
        endAction: t.endAction, fadeOut: t.fadeOut
      }
    });
  }

  function resetSession() {
    state.session = { elapsed: 0, bpm: null, done: false };
    if (workletNode) workletNode.port.postMessage({ type: 'sessionReset' });
    renderTimer();
    renderMetronome();
  }

  function onSessionTick(info) {
    if (!info.active) return;
    state.session.elapsed = info.elapsed;
    state.session.bpm = info.bpm;
    state.session.done = info.done;
    renderTimer();
    if (isGlideActive()) renderMetronome();
  }

  function onSessionEnded(action) {
    state.session.done = true;
    track('timer-finished');
    renderTimer();
    if (action === 'fade') {
      stop();
      $('statusText').textContent = 'TIMER FINISHED';
      $('visualizerState').textContent = 'TIMER FINISHED';
    } else {
      $('statusText').textContent = 'TIMER FINISHED · STILL PLAYING';
    }
  }

  function setSegmented(groupId, value) {
    document.querySelectorAll(`#${groupId} button`).forEach((button) => {
      const active = button.dataset.value === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setTimerEnabled(enabled) {
    state.timer.enabled = Boolean(enabled);
    $('timerEnabled').checked = state.timer.enabled;
    if (state.timer.enabled) { resetSession(); track('timer-on'); }
    syncTimerControls();
  }

  // Reads and validates every timer input, updates the UI and informs the audio engine.
  function syncTimerControls() {
    const t = state.timer;
    t.minutes = clampInt($('timerMinutes').value, 1, 15, t.minutes);
    t.startBpm = clampInt($('glideStart').value, 30, 240, t.startBpm);
    t.endBpm = clampInt($('glideEnd').value, 30, 240, t.endBpm);
    t.fadeOut = clampInt($('fadeInput').value, 1, 30, t.fadeOut);

    $('timerMinutes').value = $('timerMinutesRange').value = t.minutes;
    $('glideStart').value = $('glideStartRange').value = t.startBpm;
    $('glideEnd').value = $('glideEndRange').value = t.endBpm;
    $('fadeInput').value = $('fadeRange').value = t.fadeOut;
    document.querySelectorAll('#timerChips .chip').forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.minutes) === t.minutes);
    });
    setSegmented('endGroup', t.endAction);
    setSegmented('curveGroup', t.curve);
    $('curveDesc').textContent = curveDescriptions[t.curve];
    $('fadeControl').hidden = t.endAction !== 'fade';
    $('glideEnabled').checked = t.glide;
    $('glideBlock').classList.toggle('glide-on', t.glide);
    $('timerPanel').classList.toggle('timer-on', t.enabled);
    $('timerEnabled').setAttribute('aria-checked', String(t.enabled));

    sendSession();
    drawCurve();
    renderTimer();
    updateTimerSummary();
    syncMetronomeControls();
  }

  function updateTimerSummary() {
    const t = state.timer;
    if (!t.enabled) {
      $('timerSummary').textContent = 'Off — plays until you pause';
      return;
    }
    const parts = [`${t.minutes} min`];
    if (t.glide) parts.push(`tempo ${t.startBpm} → ${t.endBpm} BPM (${t.curve === 'smooth' ? 'ease in-out' : t.curve})`);
    parts.push(t.endAction === 'fade' ? `fades out over ${Math.min(t.fadeOut, t.minutes * 60)} s` : 'keeps playing at the end');
    let text = parts.join(' · ');
    if (t.glide && !state.metronomeEnabled) text += ' — turn on the inverted metronome to hear the glide';
    $('timerSummary').textContent = text;
  }

  function renderTimer() {
    const t = state.timer, s = state.session;
    const duration = t.minutes * 60;
    const elapsed = Math.min(Math.max(0, s.elapsed), duration);
    const clock = fmtTime(Math.ceil(duration - elapsed - 0.001));
    const pct = (elapsed / duration) * 100;
    const glide = isGlideActive();
    const bpm = s.bpm || t.startBpm;

    $('timerClock').textContent = clock;
    $('timerFill').style.width = `${pct.toFixed(2)}%`;
    $('timerBar').setAttribute('aria-valuenow', String(Math.round(pct)));
    $('timerElapsed').textContent = `${fmtTime(Math.floor(elapsed))} elapsed of ${fmtTime(duration)}`;
    $('timerBpmLive').textContent = glide ? `${bpm.toFixed(1)} BPM` : '';

    $('sessionBadge').hidden = !t.enabled;
    $('sessionBadgeText').textContent = glide ? `${clock} · ${Math.round(bpm)} BPM` : clock;
    document.title = state.playing && t.enabled ? `${clock} · BrainSilencer` : baseTitle;
    updatePlayhead(elapsed / duration);
  }

  function drawCurve() {
    const t = state.timer;
    let lo = Math.min(t.startBpm, t.endBpm), hi = Math.max(t.startBpm, t.endBpm);
    if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const x = (u) => CURVE_PX + u * (CURVE_W - 2 * CURVE_PX);
    const y = (v) => CURVE_H - CURVE_PY - ((v - lo) / (hi - lo)) * (CURVE_H - 2 * CURVE_PY);
    curveMap = { x, y };

    let line = '';
    for (let i = 0; i <= 80; i++) {
      const u = i / 80;
      line += `${i ? 'L' : 'M'}${x(u).toFixed(1)} ${y(glideValue(u)).toFixed(1)} `;
    }
    const area = `${line}L${x(1).toFixed(1)} ${CURVE_H} L${x(0).toFixed(1)} ${CURVE_H} Z`;
    $('curveSvg').innerHTML =
      '<defs><linearGradient id="curveGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#a9f36d" stop-opacity=".22"/><stop offset="1" stop-color="#a9f36d" stop-opacity="0"/></linearGradient></defs>' +
      `<line class="curve-grid" x1="0" x2="${CURVE_W}" y1="${CURVE_H / 3}" y2="${CURVE_H / 3}"/>` +
      `<line class="curve-grid" x1="0" x2="${CURVE_W}" y1="${CURVE_H * 2 / 3}" y2="${CURVE_H * 2 / 3}"/>` +
      `<path class="curve-area" d="${area}"/><path class="curve-line" d="${line}"/>` +
      `<line class="curve-playhead" id="curvePlayhead" y1="0" y2="${CURVE_H}"/><line class="curve-dot" id="curveDot"/>`;
    $('curveStartLabel').textContent = `START · ${t.startBpm} BPM`;
    $('curveEndLabel').textContent = `${t.minutes}:00 · END ${t.endBpm} BPM`;
    updatePlayhead(Math.min(1, state.session.elapsed / (t.minutes * 60)));
  }

  function updatePlayhead(u) {
    const head = $('curvePlayhead'), dot = $('curveDot');
    if (!head || !dot || !curveMap) return;
    const px = curveMap.x(u);
    head.setAttribute('x1', px); head.setAttribute('x2', px);
    const py = curveMap.y(glideValue(u));
    ['x1', 'x2'].forEach((k) => dot.setAttribute(k, px));
    ['y1', 'y2'].forEach((k) => dot.setAttribute(k, py));
  }

  function wireStepper(inputId, rangeId, downId, upId, step, onChange) {
    const input = $(inputId);
    const apply = (value) => { input.value = value; onChange(); };
    input.addEventListener('change', onChange);
    $(rangeId).addEventListener('input', (event) => apply(event.target.value));
    $(downId).addEventListener('click', () => apply(Number(input.value || 0) - step));
    $(upId).addEventListener('click', () => apply(Number(input.value || 0) + step));
  }

  function draw() {
    if (!state.playing) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.clearRect(0, 0, width, height);
    const midY = height * 0.58;
    ctx.beginPath(); ctx.strokeStyle = 'rgba(169,243,109,0.12)'; ctx.lineWidth = 1;
    ctx.moveTo(0, midY); ctx.lineTo(width, midY); ctx.stroke();
    const bars = 100, gap = Math.max(2, width / 450), barWidth = width / bars - gap;
    for (let i = 0; i < bars; i++) {
      const value = lastWave[(i * 7 + phase) % lastWave.length] || 0;
      const amplitude = Math.min(height * 0.39, Math.abs(value) * height * 0.8 + 2 * dpr);
      const x = i * (width / bars);
      ctx.fillStyle = `rgba(169,243,109,${0.2 + Math.min(0.6, amplitude / height)})`;
      ctx.fillRect(x, midY - amplitude / 2, Math.max(1, barWidth), amplitude);
    }
    phase = (phase + 1) % lastWave.length;
    animationFrame = requestAnimationFrame(draw);
  }

  function drawStatic() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(169,243,109,0.45)'; ctx.lineWidth = 1.5 * dpr;
    for (let x = 0; x < w; x++) {
      const y = h * 0.58 + Math.sin(x * 0.025) * 8 * dpr + Math.sin(x * 0.008) * 12 * dpr;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  $('playButton').addEventListener('click', () => state.playing ? stop() : play());
  document.querySelectorAll('.profile-card').forEach((card) => card.addEventListener('click', () => setType(card.dataset.type)));
  $('masterVolume').addEventListener('input', (event) => {
    state.volume = Number(event.target.value) / 100;
    $('volumeValue').textContent = `${event.target.value}%`;
    if (masterGain && audioContext) masterGain.gain.setTargetAtTime(state.playing ? state.volume : 0, audioContext.currentTime, 0.035);
  });
  $('lowBand').addEventListener('input', () => updateRange('lowBand', 'low', 'lowValue'));
  $('midBand').addEventListener('input', () => updateRange('midBand', 'mid', 'midValue'));
  $('highBand').addEventListener('input', () => updateRange('highBand', 'high', 'highValue'));
  $('resetButton').addEventListener('click', () => {
    $('lowBand').value = 75; $('midBand').value = 55; $('highBand').value = 30;
    updateRange('lowBand', 'low', 'lowValue'); updateRange('midBand', 'mid', 'midValue'); updateRange('highBand', 'high', 'highValue');
    $('masterVolume').value = 65; state.volume = 0.65; $('volumeValue').textContent = '65%';
    if (masterGain && audioContext) masterGain.gain.setTargetAtTime(state.playing ? state.volume : 0, audioContext.currentTime, 0.035);
    setType('ultimate');
  });
  $('metronomeEnabled').addEventListener('change', (event) => setMetronomeEnabled(event.target.checked));
  $('bpmInput').addEventListener('change', syncMetronomeControls);
  $('bpmRange').addEventListener('input', (event) => { $('bpmInput').value = event.target.value; syncMetronomeControls(); });
  $('bpmDown').addEventListener('click', () => { $('bpmInput').value = Math.max(30, Number($('bpmInput').value || 60) - 1); syncMetronomeControls(); });
  $('bpmUp').addEventListener('click', () => { $('bpmInput').value = Math.min(240, Number($('bpmInput').value || 60) + 1); syncMetronomeControls(); });
  $('silenceInput').addEventListener('change', syncMetronomeControls);
  $('silenceRange').addEventListener('input', (event) => { $('silenceInput').value = event.target.value; syncMetronomeControls(); });
  $('silenceDown').addEventListener('click', () => { $('silenceInput').value = Math.max(0, Number($('silenceInput').value || 0) - 10); syncMetronomeControls(); });
  $('silenceUp').addEventListener('click', () => { $('silenceInput').value = Math.min(Number($('silenceInput').max), Number($('silenceInput').value || 0) + 10); syncMetronomeControls(); });
  window.addEventListener('resize', () => { if (!state.playing) drawStatic(); });

  /* ---------- Saved settings (localStorage) ---------- */

  const STORAGE_KEY = 'brainsilencer.settings.v1';

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        type: state.type, volume: state.volume,
        low: state.low, mid: state.mid, high: state.high,
        metronomeEnabled: state.metronomeEnabled, bpm: state.bpm, silenceMs: state.silenceMs,
        timer: state.timer
      }));
    } catch (error) { /* storage unavailable (private mode, blocked): just don't persist */ }
  }

  function loadSettings() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (error) { return; }
    if (!saved || typeof saved !== 'object') return;
    const num = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

    if (profiles[saved.type]) setType(saved.type);

    state.volume = num(saved.volume, 0, 1, state.volume);
    $('masterVolume').value = Math.round(state.volume * 100);
    $('volumeValue').textContent = `${Math.round(state.volume * 100)}%`;
    [['lowBand', 'low', 'lowValue'], ['midBand', 'mid', 'midValue'], ['highBand', 'high', 'highValue']].forEach(([id, key, out]) => {
      $(id).value = Math.round(num(saved[key], 0, 1, state[key]) * 100);
      updateRange(id, key, out);
    });

    state.bpm = Math.round(num(saved.bpm, 30, 240, state.bpm));
    $('bpmInput').value = state.bpm;
    $('silenceInput').value = Math.round(num(saved.silenceMs, 0, 1000, state.silenceMs));
    state.metronomeEnabled = saved.metronomeEnabled === true;
    $('metronomeEnabled').checked = state.metronomeEnabled;

    const t = state.timer, st = saved.timer || {};
    t.enabled = st.enabled === true;
    t.glide = st.glide === true;
    if (['linear', 'smooth', 'exponential'].includes(st.curve)) t.curve = st.curve;
    if (['fade', 'keep'].includes(st.endAction)) t.endAction = st.endAction;
    $('timerEnabled').checked = t.enabled;
    $('timerMinutes').value = Math.round(num(st.minutes, 1, 15, t.minutes));
    $('glideStart').value = Math.round(num(st.startBpm, 30, 240, t.startBpm));
    $('glideEnd').value = Math.round(num(st.endBpm, 30, 240, t.endBpm));
    $('fadeInput').value = Math.round(num(st.fadeOut, 1, 30, t.fadeOut));
  }

  // Save after any control changes (runs after the control's own handler).
  let saveTimer = 0;
  ['input', 'change', 'click'].forEach((name) => document.addEventListener(name, () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 150);
  }));

  $('timerEnabled').addEventListener('change', (event) => setTimerEnabled(event.target.checked));
  $('timerRestart').addEventListener('click', resetSession);
  wireStepper('timerMinutes', 'timerMinutesRange', 'timerDown', 'timerUp', 1, syncTimerControls);
  wireStepper('glideStart', 'glideStartRange', 'glideStartDown', 'glideStartUp', 1, syncTimerControls);
  wireStepper('glideEnd', 'glideEndRange', 'glideEndDown', 'glideEndUp', 1, syncTimerControls);
  wireStepper('fadeInput', 'fadeRange', 'fadeDown', 'fadeUp', 1, syncTimerControls);
  document.querySelectorAll('#timerChips .chip').forEach((chip) => chip.addEventListener('click', () => {
    $('timerMinutes').value = chip.dataset.minutes;
    syncTimerControls();
  }));
  document.querySelectorAll('#endGroup button').forEach((button) => button.addEventListener('click', () => {
    state.timer.endAction = button.dataset.value;
    syncTimerControls();
  }));
  document.querySelectorAll('#curveGroup button').forEach((button) => button.addEventListener('click', () => {
    state.timer.curve = button.dataset.value;
    syncTimerControls();
  }));
  $('glideSwap').addEventListener('click', () => {
    const start = $('glideStart').value;
    $('glideStart').value = $('glideEnd').value;
    $('glideEnd').value = start;
    syncTimerControls();
  });
  $('glideEnabled').addEventListener('change', (event) => {
    state.timer.glide = event.target.checked;
    if (state.timer.glide) {
      track('glide-on');
      if (!state.timer.enabled) setTimerEnabled(true);
      if (!state.metronomeEnabled) setMetronomeEnabled(true);
    }
    syncTimerControls();
  });

  loadSettings(); setType(state.type); syncTimerControls(); drawStatic();
})();
