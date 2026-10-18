// Spoken cues ("music", "podcast", "all done") and the optional "pedals ready" sound.
//
// For the cue to land the instant a pedal is pressed, cue audio is decoded ahead
// of time and played through Web Audio on the same, already-running audio context
// the speaker keep-awake uses. Sources, in priority order:
//   1. a recording made in the app's Settings (stored on this device)
//   2. a file set in config.js (cues.<name>.file)
//   3. the browser's text-to-speech, as a last resort. This can lag noticeably,
//      especially if the system voice is an online one, so it's only a fallback.
// Leading and trailing silence is trimmed off recordings and files.

const NAMES = ['music', 'podcast', 'silence'];

export class Cues {
  constructor(config, { getContext, storage }) {
    this.config = config;
    this.getContext = getContext; // () => running AudioContext or null
    this.storage = storage;
    this.buffers = {}; // name -> AudioBuffer (trimmed)
    this._playing = null; // { stop() }
    this._readyCtx = null;
  }

  // Decode all cue sources. Call again after recordings change or once the
  // audio context exists.
  async load() {
    const ctx = this.getContext();
    if (!ctx) return;
    this._readyCtx = ctx;
    await Promise.all(
      NAMES.map(async (name) => {
        const src = this.recording(name) || this.config.cues[name]?.file;
        if (!src) return delete this.buffers[name];
        try {
          const res = await fetch(src);
          const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers[name] = trimSilence(ctx, normalize(decoded));
        } catch (err) {
          console.warn(`cue ${name} failed to load`, err);
          delete this.buffers[name];
        }
      }),
    );
  }

  recording(name) {
    return this.storage.get(`cue.${name}`);
  }

  async setRecording(name, dataUrl) {
    if (dataUrl) this.storage.set(`cue.${name}`, dataUrl);
    else this.storage.set(`cue.${name}`, null);
    await this.load();
  }

  // Which source each cue will use, for the settings panel.
  sourceOf(name) {
    if (this.buffers[name]) return this.recording(name) ? 'your recording' : 'sound file';
    return 'text-to-speech (may lag)';
  }

  // Resolves when the cue has finished.
  async play(name) {
    const ctx = this.getContext();
    if (ctx && ctx !== this._readyCtx) await this.load();
    const buf = this.buffers[name];
    if (ctx && buf) return this._playBuffer(ctx, buf);
    const cue = this.config.cues[name];
    if (cue?.speak) return this._speak(cue.speak);
  }

  stop() {
    if (this._playing) {
      this._playing.stop();
      this._playing = null;
    }
    if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
  }

  async ready() {
    const r = this.config.readySound;
    if (!r) return;
    const ctx = this.getContext();
    if (!ctx) return;
    if (r === 'tone') return this._tone(ctx);
    try {
      const res = await fetch(r);
      this._playBuffer(ctx, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch { /* ignore */ }
  }

  _playBuffer(ctx, buf) {
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // Boost, then a limiter so the boost makes speech louder without clipping.
      const gain = ctx.createGain();
      gain.gain.value = this.config.cueVolume ?? 1;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 6;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      src.connect(gain).connect(limiter).connect(ctx.destination);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(finish, buf.duration * 1000 + 500);
      src.onended = finish;
      this._playing = { stop: () => { try { src.stop(); } catch { /* already stopped */ } finish(); } };
      src.start();
    });
  }

  _speak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      // Prefer a voice that runs on the device; online voices add a network round trip.
      const voices = speechSynthesis.getVoices();
      const lang = (navigator.language || 'en').slice(0, 2);
      u.voice =
        voices.find((v) => v.localService && v.lang.startsWith(lang) && v.default) ||
        voices.find((v) => v.localService && v.lang.startsWith(lang)) ||
        null;
      const t = setTimeout(resolve, 5000);
      u.onend = u.onerror = () => { clearTimeout(t); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  _tone(ctx) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
  }
}

// Scale so the loudest point is just under full scale (mic recordings usually
// come in far quieter than music). Gain is capped so a near-silent recording
// doesn't turn into amplified hiss.
export function normalize(buf, target = 0.95, maxGain = 40) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (!peak) return buf;
  const g = Math.min(maxGain, target / peak);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

// Cut leading/trailing near-silence (keeping a few ms of margin) so a cue
// recorded with a pause before the word still plays immediately.
export function trimSilence(ctx, buf, threshold = 0.06, marginSec = 0.04) {
  const ch = buf.getChannelData(0);
  let start = 0;
  let end = ch.length - 1;
  while (start < ch.length && Math.abs(ch[start]) < threshold) start++;
  while (end > start && Math.abs(ch[end]) < threshold) end--;
  if (start >= end) return buf; // all quiet; leave it alone
  const margin = Math.floor(marginSec * buf.sampleRate);
  start = Math.max(0, start - margin);
  end = Math.min(ch.length - 1, end + margin);
  const out = ctx.createBuffer(buf.numberOfChannels, end - start + 1, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(start, end + 1), c);
  }
  return out;
}
