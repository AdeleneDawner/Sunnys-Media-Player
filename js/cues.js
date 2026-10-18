// Spoken/recorded cues ("music", "podcast", "all done") and the optional
// "pedals ready" sound. A recorded file is used if configured and it loads;
// otherwise the browser's text-to-speech says the phrase.

export class Cues {
  constructor(config) {
    this.config = config;
    this._audio = null;
    this._ctx = null;
  }

  async play(name) {
    const cue = this.config.cues[name];
    if (!cue) return;
    if (cue.file) {
      try {
        await this._playFile(cue.file);
        return;
      } catch {
        /* fall through to speech */
      }
    }
    if (cue.speak) await this._speak(cue.speak);
  }

  stop() {
    if (this._audio) {
      this._audio.pause();
      this._audio = null;
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  async ready() {
    const r = this.config.readySound;
    if (!r) return;
    if (r === 'tone') return this._tone();
    try { await this._playFile(r); } catch { /* ignore */ }
  }

  _playFile(src) {
    return new Promise((resolve, reject) => {
      const a = new Audio(src);
      this._audio = a;
      a.volume = this.config.cueVolume ?? 1;
      const t = setTimeout(resolve, 8000);
      a.addEventListener('ended', () => { clearTimeout(t); resolve(); }, { once: true });
      a.addEventListener('pause', () => { clearTimeout(t); resolve(); }, { once: true });
      a.addEventListener('error', () => { clearTimeout(t); reject(new Error('cue file failed')); }, { once: true });
      a.play().catch((e) => { clearTimeout(t); reject(e); });
    });
  }

  _speak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      const t = setTimeout(resolve, 5000);
      u.onend = u.onerror = () => { clearTimeout(t); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  _tone() {
    try {
      this._ctx ||= new AudioContext();
      const ctx = this._ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.32);
    } catch { /* ignore */ }
  }
}
