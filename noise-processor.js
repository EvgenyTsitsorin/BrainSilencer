const MIN_BPM = 30;
const MAX_BPM = 240;

class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'low', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mid', defaultValue: 0.55, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'high', defaultValue: 0.30, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bpm', defaultValue: 60, minValue: 30, maxValue: 240, automationRate: 'k-rate' },
      { name: 'silenceMs', defaultValue: 120, minValue: 0, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'metroEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.type = 'ultimate';
    this.pinkB = new Float64Array(7);
    this.brownState = 0;
    this.lp250 = 0;
    this.lp3000 = 0;
    this.fadeSeconds = 0.004;

    // Metronome clock: frames since the last beat. A running counter (instead of
    // "absolute frame % beat length") keeps the rhythm continuous while BPM changes.
    this.beatPos = 0;
    this.bpmNow = 0;          // smoothed BPM actually used (0 = not initialised yet)
    this.gainNow = 1;         // smoothed fade-out gain
    this.blockCount = 0;

    // What plays inside the metronome gap: silence or another noise type.
    // msMain / msAlt are running mean-square levels, used to match the loudness of the
    // alternative noise to the main one (white, pink and brown differ a lot in raw level).
    this.pause = { type: 'silence', level: 1 };
    this.levelNow = 1;
    this.lowGain = 0.75; this.midGain = 0.55; this.highGain = 0.30;
    this.msMain = 0.1; this.msAlt = 0.1;

    // Session timer. Runs on the audio clock, so it keeps exact time even when the
    // tab is in the background and also pauses automatically with the AudioContext.
    this.elapsed = 0;
    this.endReported = false;
    this.session = {
      enabled: false, duration: 300, glide: false,
      startBpm: 60, endBpm: 30, curve: 'linear',
      endAction: 'fade', fadeOut: 10
    };

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'setType' && ['ultimate', 'white', 'pink', 'brown'].includes(data.value)) {
        this.type = data.value;
        this.calibrate();
      } else if (data.type === 'pause' && data.value) {
        const v = data.value;
        if (v.type === 'silence' || ['ultimate', 'white', 'pink', 'brown'].includes(v.type)) this.pause.type = v.type;
        if (Number.isFinite(v.level)) this.pause.level = Math.min(1, Math.max(0, v.level));
        this.calibrate();
      } else if (data.type === 'start' || data.type === 'resetClock') {
        this.beatPos = 0;
      } else if (data.type === 'sessionReset') {
        this.elapsed = 0;
        this.endReported = false;
      } else if (data.type === 'session' && data.value) {
        const v = data.value, s = this.session;
        if (typeof v.enabled === 'boolean') s.enabled = v.enabled;
        if (typeof v.glide === 'boolean') s.glide = v.glide;
        if (Number.isFinite(v.duration)) s.duration = Math.max(1, v.duration);
        if (Number.isFinite(v.startBpm)) s.startBpm = Math.min(MAX_BPM, Math.max(MIN_BPM, v.startBpm));
        if (Number.isFinite(v.endBpm)) s.endBpm = Math.min(MAX_BPM, Math.max(MIN_BPM, v.endBpm));
        if (Number.isFinite(v.fadeOut)) s.fadeOut = Math.max(0, v.fadeOut);
        if (['linear', 'smooth', 'exponential'].includes(v.curve)) s.curve = v.curve;
        if (['fade', 'keep'].includes(v.endAction)) s.endAction = v.endAction;
      }
    };
  }

  // The alternative gap noise, or null for silence. Choosing the main noise itself means no gap sound.
  altType() {
    const t = this.pause.type;
    return t !== 'silence' && t !== this.type ? t : null;
  }

  // One sample of the given noise type. Each type keeps its own filter state, so the main
  // and the alternative noise can run side by side.
  gen(type, lowGain, midGain, highGain) {
    if (type === 'white') return this.white();
    if (type === 'pink') return this.pink();
    if (type === 'brown') return this.brown();
    const white = this.white();
    this.lp250 = this.lowPass(white, this.lp250, 250);
    this.lp3000 = this.lowPass(white, this.lp3000, 3000);
    const low = this.lp250;
    const mid = this.lp3000 - this.lp250;
    const high = white - this.lp3000;
    return low * lowGain * 2.0 + mid * midGain * 1.4 + high * highGain;
  }

  // Measures the loudness of the main and alternative noise on a short throw-away run,
  // so the gap noise has the right level from its very first beat. The generator states are
  // restored afterwards, so the audible stream stays continuous.
  calibrate() {
    const saved = [Float64Array.from(this.pinkB), this.brownState, this.lp250, this.lp3000];
    const alt = this.altType();
    const N = 8192;
    let a = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const x = this.gen(this.type, this.lowGain, this.midGain, this.highGain);
      a += x * x;
      if (alt) { const y = this.gen(alt, this.lowGain, this.midGain, this.highGain); b += y * y; }
    }
    this.msMain = Math.max(1e-9, a / N);
    this.msAlt = alt ? Math.max(1e-9, b / N) : this.msMain;
    this.pinkB.set(saved[0]); this.brownState = saved[1]; this.lp250 = saved[2]; this.lp3000 = saved[3];
  }

  white() { return Math.random() * 2 - 1; }

  pink() {
    const w = this.white(), b = this.pinkB;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.96900 * b[2] + w * 0.1538520;
    b[3] = 0.86650 * b[3] + w * 0.3104856;
    b[4] = 0.55000 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.0168980;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return out * 0.11;
  }

  brown() {
    this.brownState = (this.brownState + this.white() * 0.02) / 1.02;
    return this.brownState * 3.5;
  }

  lowPass(input, previous, cutoff) {
    const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
    return previous + alpha * (input - previous);
  }

  // BPM at position t (0..1) of the session.
  glideBpm(t) {
    const s = this.session;
    t = Math.min(1, Math.max(0, t));
    const a = s.startBpm, b = s.endBpm;
    let v;
    if (s.curve === 'smooth') v = a + (b - a) * t * t * (3 - 2 * t);   // ease in-out
    else if (s.curve === 'exponential') v = a * Math.pow(b / a, t);  // constant % change
    else v = a + (b - a) * t;                                        // linear
    return Math.min(MAX_BPM, Math.max(MIN_BPM, v));
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0][0];
    const n = output.length;
    const dt = n / sampleRate;
    const s = this.session;
    const lowGain = parameters.low[0];
    const midGain = parameters.mid[0];
    const highGain = parameters.high[0];
    this.lowGain = lowGain; this.midGain = midGain; this.highGain = highGain;

    // --- Session timer: target tempo and fade-out gain for this block ---
    let targetBpm = parameters.bpm[0];
    let targetGain = 1;
    let done = false;
    if (s.enabled) {
      if (s.glide) targetBpm = this.glideBpm(this.elapsed / s.duration);
      this.elapsed = Math.min(s.duration, this.elapsed + dt);
      const remaining = s.duration - this.elapsed;
      done = remaining <= 0;
      if (s.endAction === 'fade') {
        const fade = Math.max(0.05, Math.min(s.fadeOut, s.duration));
        if (remaining < fade) targetGain = Math.sin(Math.max(0, remaining) / fade * Math.PI / 2);
      }
    }

    // Smooth the effective BPM (≈0.25 s time constant) so that any change —
    // glide start, manual edit, switching glide off — never causes a rhythm jump.
    if (!this.bpmNow) this.bpmNow = targetBpm;
    this.bpmNow += (targetBpm - this.bpmNow) * (1 - Math.exp(-dt / 0.25));
    const bpm = this.bpmNow;

    const silenceSeconds = Math.min(parameters.silenceMs[0] / 1000, Math.max(0, 60 / bpm - this.fadeSeconds * 2));
    const metro = parameters.metroEnabled[0] >= 0.5 && silenceSeconds > 0;
    const beatFrames = sampleRate * 60 / bpm;
    const silenceFrames = silenceSeconds * sampleRate;
    const fadeFrames = Math.max(1, this.fadeSeconds * sampleRate);
    const gain0 = this.gainNow;
    const gain1 = targetGain;

    // Gap noise: follow the level control smoothly and match its loudness to the main noise.
    const alt = this.altType();
    this.levelNow += (this.pause.level - this.levelNow) * (1 - Math.exp(-dt / 0.03));
    const altGain = alt ? Math.min(20, this.levelNow * Math.sqrt(this.msMain / Math.max(1e-9, this.msAlt))) : 0;
    const msK = 1 / (sampleRate * 1.5);

    const wave = new Float32Array(256);
    for (let i = 0; i < n; i++) {
      let sample;

      sample = this.gen(this.type, lowGain, midGain, highGain);
      this.msMain += (sample * sample - this.msMain) * msK;

      if (metro) {
        const phase = this.beatPos;
        let envelope = 1;
        // Fade out just before each beat, stay silent for the requested interval,
        // then fade back in. The fully silent interval remains the requested duration.
        if (phase < silenceFrames) {
          envelope = 0;
        } else if (phase < silenceFrames + fadeFrames) {
          envelope = (phase - silenceFrames) / fadeFrames;
        } else if (phase >= beatFrames - fadeFrames) {
          envelope = (beatFrames - phase) / fadeFrames;
        }
        envelope = Math.max(0, Math.min(1, envelope));
        if (alt) {
          const other = this.gen(alt, lowGain, midGain, highGain);
          this.msAlt += (other * other - this.msAlt) * msK;
          sample = sample * envelope + other * altGain * (1 - envelope);
        } else {
          sample *= envelope;
        }
      }

      if (gain0 !== 1 || gain1 !== 1) sample *= gain0 + (gain1 - gain0) * ((i + 1) / n);

      this.beatPos += 1;
      if (this.beatPos >= beatFrames) this.beatPos %= beatFrames;

      output[i] = sample;
      if (i % Math.max(1, Math.floor(output.length / wave.length)) === 0) {
        const index = Math.min(wave.length - 1, Math.floor(i / output.length * wave.length));
        wave[index] = sample;
      }
    }
    this.gainNow = gain1;

    const message = { wave };
    const reportEnd = s.enabled && done && !this.endReported;
    if (reportEnd) {
      this.endReported = true;
      message.ended = true;
      message.action = s.endAction;
    } else if (!done) {
      this.endReported = false;
    }
    if (reportEnd || (this.blockCount++ & 15) === 0) {
      message.session = { active: s.enabled, elapsed: this.elapsed, duration: s.duration, bpm, done };
    }
    this.port.postMessage(message);
    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);
