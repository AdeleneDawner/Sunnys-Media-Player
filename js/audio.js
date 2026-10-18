// Single audio output. Everything Sunny hears from a source goes through here,
// so later upgrades (e.g. a Web Audio compressor to even out loudness) only
// need to change this file. Note: a compressor needs the audio to come with
// CORS headers (or through a proxy), otherwise Chrome outputs silence for
// cross-origin media routed through Web Audio.

export class AudioOutput {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'none';
    this.gen = 0;
    this.active = false; // true once the current source is actually playing
    this._pending = null;
    this._stallTimer = null;
    this._onEnded = () => {};
    this._onFailure = () => {};
    this.stallTimeoutMs = 20000;

    const el = this.el;
    el.addEventListener('ended', () => {
      if (this.active) {
        this.active = false;
        this._onEnded();
      }
    });
    el.addEventListener('error', () => {
      if (this.active) this._fail(new Error(mediaErrorText(el.error)));
    });
    const startStallTimer = () => {
      if (!this.active || this._stallTimer) return;
      this._stallTimer = setTimeout(() => {
        this._stallTimer = null;
        if (this.active) this._fail(new Error('stalled'));
      }, this.stallTimeoutMs);
    };
    el.addEventListener('waiting', startStallTimer);
    el.addEventListener('stalled', startStallTimer);
    el.addEventListener('playing', () => this._clearStall());
  }

  onEnded(cb) { this._onEnded = cb; }
  onFailure(cb) { this._onFailure = cb; }

  get position() {
    return this.el.currentTime || 0;
  }

  // Resolves once audio is actually playing; rejects on error/timeout, or
  // with { superseded: true } if stop()/start() is called first.
  start(url, { volume = 1, startAt = 0, timeoutMs = 15000, cors = false } = {}) {
    this._supersede();
    const gen = ++this.gen;
    const el = this.el;
    this.active = false;
    this._clearStall();

    el.pause();
    el.volume = Math.max(0, Math.min(1, volume));
    // cors: request with CORS ("crossorigin=anonymous"). Servers that allow it get
    // past the browser's opaque-response blocking (ORB), which can reject live
    // streams fetched the plain way. Servers that don't allow it fail instead.
    if (cors) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
    el.src = url;

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener('playing', onPlaying);
        el.removeEventListener('error', onError);
        el.removeEventListener('loadedmetadata', onMeta);
        if (this._pending?.gen === gen) this._pending = null;
      };
      const finish = (ok, val) => {
        cleanup();
        ok ? resolve(val) : reject(val);
      };
      const onPlaying = () => {
        if (gen !== this.gen) return;
        this.active = true;
        finish(true);
      };
      const onError = () => {
        if (gen !== this.gen) return;
        const err = new Error(mediaErrorText(el.error)); // read before unloading clears it
        this._unload();
        finish(false, err);
      };
      const onMeta = () => {
        if (startAt > 0 && gen === this.gen) {
          try { el.currentTime = startAt; } catch { /* ignore; plays from start */ }
        }
      };

      this._pending = { gen, cancel: (err) => finish(false, err) };
      el.addEventListener('playing', onPlaying);
      el.addEventListener('error', onError);
      el.addEventListener('loadedmetadata', onMeta);
      timer = setTimeout(() => {
        if (gen !== this.gen) return;
        this._unload();
        finish(false, new Error(`didn't start within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      el.play().catch((err) => {
        if (gen !== this.gen) return;
        if (err?.name === 'AbortError') return; // superseded or reloaded; handled elsewhere
        if (err?.name === 'NotSupportedError') return; // the 'error' event reports this with a better message
        finish(false, err?.name === 'NotAllowedError'
          ? new Error('browser blocked autoplay (page needs a tap or key press first)')
          : err);
      });
    });
  }

  stop() {
    this._supersede();
    this.gen++;
    this.active = false;
    this._clearStall();
    this._unload();
  }

  _supersede() {
    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      p.cancel(Object.assign(new Error('superseded'), { superseded: true }));
    }
  }

  _fail(err) {
    this.active = false;
    this._clearStall();
    this.gen++;
    this._unload();
    this._onFailure(err);
  }

  _unload() {
    const el = this.el;
    el.pause();
    if (el.getAttribute('src')) {
      el.removeAttribute('src');
      el.load();
    }
  }

  _clearStall() {
    clearTimeout(this._stallTimer);
    this._stallTimer = null;
  }
}

function mediaErrorText(e) {
  if (!e) return 'playback error';
  const names = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported or unreachable' };
  return names[e.code] || `media error ${e.code}`;
}
