// Keeps a Bluetooth speaker from sleeping during quiet stretches by playing a
// constant, very quiet low-frequency noise. Many speakers power down their amp
// after a moment of digital silence and clip the first second or two of the
// next sound; any non-zero signal prevents that.
//
// The noise is low-passed ("brown") so there's no hiss: dogs hear high
// frequencies far better than we do, so it's kept well away from them.

export class KeepAwake {
  constructor({ level = 0.01, cutoffHz = 150 } = {}) {
    this.level = level;
    this.cutoffHz = cutoffHz;
    this.ctx = null;
    this.gain = null;
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  // Safe to call repeatedly; call from user input (key press / click), since
  // Chrome only lets audio start after the page has been interacted with.
  // The audio context is also used to play the cues, so it's created even when
  // the keep-awake level is 0 (the noise is just silent then).
  async start() {
    try {
      if (!this.ctx) this._build();
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch (err) {
      console.warn('audio context failed to start', err);
    }
  }

  setLevel(level) {
    this.level = level;
    if (this.gain) this.gain.gain.value = level;
  }

  _build() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    // If the system suspends audio (e.g. a Bluetooth reconnect), resume right away
    // rather than waiting for the next press.
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    });
    // 4 seconds of brown noise, looped.
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    // Fade the loop seam so it doesn't click.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] *= t;
      data[len - 1 - i] *= t;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this.cutoffHz;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.level;
    src.connect(lp).connect(this.gain).connect(ctx.destination);
    src.start();
  }
}
