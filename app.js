(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $('waveCanvas');
  const ctx = canvas.getContext('2d');
  const state = {
    type: 'ultimate', playing: false, volume: 0.65,
    low: 0.75, mid: 0.55, high: 0.30,
    metronomeEnabled: false, bpm: 60, silenceMs: 120
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
      workletNode.port.onmessage = (event) => {
        if (event.data && event.data.wave) lastWave.set(event.data.wave.slice(0, lastWave.length));
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
      workletNode.port.postMessage({ type: 'start' });
      masterGain.gain.cancelScheduledValues(audioContext.currentTime);
      masterGain.gain.setTargetAtTime(state.volume, audioContext.currentTime, 0.025);
      state.playing = true;
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

  function syncMetronomeControls() {
    const bpmInput = $('bpmInput');
    const rawBpm = Number(bpmInput.value);
    state.bpm = Math.max(30, Math.min(240, Number.isFinite(rawBpm) ? rawBpm : 60));
    bpmInput.value = state.bpm;
    $('bpmRange').value = state.bpm;

    const maxSilence = Math.max(0, Math.min(1000, Math.floor(60000 / state.bpm - 8)));
    $('silenceInput').max = maxSilence;
    $('silenceRange').max = maxSilence;
    const rawSilence = Number($('silenceInput').value);
    state.silenceMs = Math.max(0, Math.min(maxSilence, Number.isFinite(rawSilence) ? rawSilence : 120));
    $('silenceInput').value = state.silenceMs;
    $('silenceRange').value = state.silenceMs;
    $('metronomePanel').classList.toggle('metro-enabled', state.metronomeEnabled);
    $('metronomeSummary').textContent = state.metronomeEnabled
      ? `${state.silenceMs} ms of silence · every ${Math.round(60000 / state.bpm)} ms (${state.bpm} BPM)`
      : 'Off — noise plays continuously';
    $('metronomeEnabled').setAttribute('aria-checked', String(state.metronomeEnabled));
    setParam('bpm', state.bpm, 0.01);
    setParam('silenceMs', state.silenceMs, 0.01);
    setParam('metroEnabled', state.metronomeEnabled ? 1 : 0, 0.01);
  }

  function setMetronomeEnabled(enabled) {
    state.metronomeEnabled = Boolean(enabled);
    if (state.metronomeEnabled && workletNode) workletNode.port.postMessage({ type: 'resetClock' });
    syncMetronomeControls();
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

  setType('ultimate'); syncMetronomeControls(); drawStatic();
})();
