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

const NAMES = ['music', 'podcast', 'silence', 'refuse'];

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
          this.buffers[name] = trimSilence(ctx, processVoice(decoded, this.config.cueVolume ?? 3));
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
      // Loudness is already baked in by processVoice(); play as-is.
      src.connect(ctx.destination);
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

// Prepares a voice recording for playback, in place:
//   1. noise gate: stretches quieter than the speech (room hiss, mic noise) are
//      faded to silence, so boosting the voice doesn't boost the static;
//   2. loudness: the speech is brought to a target level set by `loudness`
//      (1 = moderate, 3 = default, 10 = as loud as it goes);
//   3. look-ahead limiter: peaks pushed past full scale are turned down smoothly
//      instead of clipping (clipping is what sounds crackly).
export function processVoice(buf, loudness = 3) {
  const sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const n = chans[0].length;
  const mono = new Float32Array(n);
  for (const d of chans) for (let i = 0; i < n; i++) mono[i] += d[i] / chans.length;

  // Short-window RMS envelope.
  const win = Math.max(1, Math.round(sr * 0.01));
  const nw = Math.ceil(n / win);
  const env = new Float32Array(nw);
  for (let w = 0; w < nw; w++) {
    let sum = 0;
    const end = Math.min(n, (w + 1) * win);
    for (let i = w * win; i < end; i++) sum += mono[i] * mono[i];
    env[w] = Math.sqrt(sum / (end - w * win));
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = sorted[Math.floor(nw * 0.1)] || 0;
  const loud = sorted[Math.floor(nw * 0.95)] || 0;
  if (!loud) return buf;

  // 1. Gate: open where the envelope is well above the noise floor and not far
  //    below the loudest speech; hold open briefly so word endings survive.
  const open = Math.max(floor * 4, loud * 0.08);
  const hold = Math.round(0.08 / 0.01);
  const gateW = new Float32Array(nw);
  for (let w = 0, held = 0; w < nw; w++) {
    if (env[w] >= open) held = hold;
    gateW[w] = held > 0 ? 1 : 0;
    held--;
  }
  for (let w = nw - 1, held = 0; w >= 0; w--) { // also open slightly before onsets
    if (env[w] >= open) held = 3;
    if (held-- > 0) gateW[w] = 1;
  }

  // 2. Loudness: scale so the speech's RMS hits the target.
  let sum = 0;
  let count = 0;
  for (let w = 0; w < nw; w++) if (gateW[w]) { sum += env[w] * env[w]; count++; }
  const speechRms = Math.sqrt(sum / Math.max(1, count)) || loud;
  const targetDb = Math.min(-6, -20 + 2 * loudness);
  const gain = Math.min(60, Math.pow(10, targetDb / 20) / speechRms);

  // Per-sample gain: gate (with 5 ms smoothing) times loudness gain.
  const g = new Float32Array(n);
  const smooth = 1 - Math.exp(-1 / (sr * 0.005));
  for (let i = 0, cur = 0; i < n; i++) {
    cur += (gateW[Math.floor(i / win)] - cur) * smooth;
    g[i] = cur * gain;
  }

  // 3. Look-ahead limiter: required reduction so |x| stays under the ceiling,
  //    spread over a few ms before each peak and released slowly after.
  const ceiling = 0.9;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(mono[i] * g[i]);
    need[i] = v > ceiling ? ceiling / v : 1;
  }
  const look = Math.round(sr * 0.005);
  const red = new Float32Array(n).fill(1);
  const dq = []; // sliding-window minimum over [i, i+look]
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + look) dq.shift();
    red[i] = need[dq[0]];
  }
  const rel = 1 - Math.exp(-1 / (sr * 0.08));
  for (let i = 0, cur = 1; i < n; i++) {
    cur = red[i] < cur ? red[i] : cur + (red[i] - cur) * rel;
    g[i] *= cur;
  }

  for (const d of chans) for (let i = 0; i < n; i++) d[i] = Math.max(-0.98, Math.min(0.98, d[i] * g[i]));
  return buf;
}

// Cut leading/trailing near-silence (keeping a few ms of margin) so a cue
// recorded with a pause before the word still plays immediately.
export function trimSilence(ctx, buf, threshold = 0.01, marginSec = 0.02) {
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
