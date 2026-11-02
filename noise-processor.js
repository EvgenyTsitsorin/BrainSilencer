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
    this.startFrame = 0;
    this.pinkB = new Float64Array(7);
    this.brownState = 0;
    this.lp250 = 0;
    this.lp3000 = 0;
    this.fadeSeconds = 0.004;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'setType' && ['ultimate', 'white', 'pink', 'brown'].includes(data.value)) {
        this.type = data.value;
      } else if (data.type === 'start') {
        this.startFrame = currentFrame;
      } else if (data.type === 'resetClock') {
        this.startFrame = currentFrame;
      }
    };
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

  process(_inputs, outputs, parameters) {
    const output = outputs[0][0];
    const lowGain = parameters.low[0];
    const midGain = parameters.mid[0];
    const highGain = parameters.high[0];
    const bpm = parameters.bpm[0];
    const silenceSeconds = Math.min(parameters.silenceMs[0] / 1000, Math.max(0, 60 / bpm - this.fadeSeconds * 2));
    const metro = parameters.metroEnabled[0] >= 0.5 && silenceSeconds > 0;
    const beatFrames = sampleRate * 60 / bpm;
    const silenceFrames = silenceSeconds * sampleRate;
    const fadeFrames = Math.max(1, this.fadeSeconds * sampleRate);

    const wave = new Float32Array(256);
    for (let i = 0; i < output.length; i++) {
      let sample;

      if (this.type === 'white') {
        sample = this.white();
      } else if (this.type === 'pink') {
        sample = this.pink();
      } else if (this.type === 'brown') {
        sample = this.brown();
      } else {
        const white = this.white();
        this.lp250 = this.lowPass(white, this.lp250, 250);
        this.lp3000 = this.lowPass(white, this.lp3000, 3000);
        const low = this.lp250;
        const mid = this.lp3000 - this.lp250;
        const high = white - this.lp3000;
        sample = low * lowGain * 2.0 + mid * midGain * 1.4 + high * highGain;
      }

      if (metro) {
        const frame = currentFrame + i - this.startFrame;
        const phase = ((frame % beatFrames) + beatFrames) % beatFrames;
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
        sample *= Math.max(0, Math.min(1, envelope));
      }

      output[i] = sample;
      if (i % Math.max(1, Math.floor(output.length / wave.length)) === 0) {
        const index = Math.min(wave.length - 1, Math.floor(i / output.length * wave.length));
        wave[index] = sample;
      }
    }
    this.port.postMessage({ wave });
    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);
