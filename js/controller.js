// The behavior of the three pedals. No DOM in here: the player, cues, logger
// and storage are passed in, so this file can be tested in Node.
//
//   music   : from silence/podcast -> resume last station (with cue)
//             while music plays     -> next station
//   podcast : from silence/music     -> resume last episode where it left off (with cue)
//             while a podcast plays  -> a different show, fresh episode
//   silence : stop, say "all done"
//
// Sources that won't start are skipped automatically.

const RECENT_DROP_WINDOW_MS = 5 * 60 * 1000;

export class Controller {
  constructor({
    config,
    player,
    cues,
    logger,
    storage,
    getShows = () => [],
    now = () => Date.now(),
    random = Math.random,
    schedule = (fn, ms) => setTimeout(fn, ms),
    onChange = () => {},
  }) {
    Object.assign(this, { config, player, cues, logger, storage, getShows, now, random, schedule, onChange });

    this.mode = 'silence';
    this.current = null; // { kind: 'music'|'podcast', label, ... }
    this.op = 0; // bumped by every new action; stale async work checks it and bails
    this.lastAcceptedAt = -Infinity;
    this.drops = []; // { key, at } for mid-play drops, to avoid retry loops

    const saved = storage.get('state') || {};
    this.music = { idx: saved.music?.idx ?? 0, goodUrl: saved.music?.goodUrl ?? {}, goodCors: saved.music?.goodCors ?? {} };
    this.podcast = {
      showKey: saved.podcast?.showKey ?? null,
      episode: saved.podcast?.episode ?? null, // { url, title, showKey, showName }
      position: saved.podcast?.position ?? 0,
      finished: saved.podcast?.finished ?? false,
    };
    this.played = saved.played ?? {}; // showKey -> recently played episode URLs

    player.onEnded(() => this._handleEnded());
    player.onFailure((err) => this._handleDrop(err));
  }

  get debounceMs() {
    return this.config.debounceMs;
  }

  // ---- public ----------------------------------------------------------

  async press(button, input) {
    const t = this.now();
    const sinceLast = t - this.lastAcceptedAt;
    const before = { mode_before: this.mode, source_before: this._label() };

    if (sinceLast < this.debounceMs) {
      this._log('press_ignored', { input, button, ...before, detail: `debounce (${Math.round(sinceLast)}ms after last accepted press)` });
      return;
    }
    this.lastAcceptedAt = t;
    if (this.config.readySound) this.schedule(() => this.cues.ready(), this.debounceMs);

    const op = ++this.op;
    this.cues.stop();

    if (button === 'silence') {
      this._log('press', { input, button, ...before, mode_after: button, source_after: '', detail: 'stop' });
      return this._silence(op);
    }
    if (button === 'music') {
      const isNext = this.mode === 'music';
      this._log('press', { input, button, ...before, mode_after: button, source_after: '', detail: isNext ? 'next station' : 'resume music' });
      return this._music(op, isNext);
    }
    if (button === 'podcast') {
      const isNext = this.mode === 'podcast';
      this._log('press', { input, button, ...before, mode_after: button, source_after: '', detail: isNext ? 'next show' : 'resume podcast' });
      return this._podcast(op, isNext);
    }
  }

  // Call every few seconds so podcast position survives a reboot.
  tick() {
    this._savePodcastPosition();
  }

  // ---- actions ---------------------------------------------------------

  async _silence(op) {
    this._savePodcastPosition();
    this.player.stop();
    this._setMode('silence', null);
    await this.cues.play('silence');
  }

  async _music(op, isNext) {
    this._savePodcastPosition();
    this.player.stop();
    this._setMode('music', null);

    const n = this.config.stations.length;
    if (!n) return this._allFailed(op, 'music: no stations configured');
    const start = isNext ? (this.music.idx + 1) % n : this.music.idx % n;

    if (this._shouldCue(isNext)) {
      await this.cues.play('music');
      if (op !== this.op) return;
    }
    await this._tryStations(op, start);
  }

  async _tryStations(op, start) {
    const stations = this.config.stations;
    const n = stations.length;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const st = stations[i];
      // A station can list backup addresses; the one that worked last is tried first.
      const urls = [...new Set([this.music.goodUrl?.[st.name], ...(st.urls || []), st.url].filter(Boolean))];
      const errors = [];
      let playing = null;
      // Each address is tried with a CORS request first, then a plain one.
      const remembered = this.music.goodCors?.[st.name];
      const attempts = urls.flatMap((url) => [true, false].map((cors) => ({ url, cors })));
      if (remembered) attempts.sort((a, b) => (b.url === urls[0] && b.cors === remembered.cors) - (a.url === urls[0] && a.cors === remembered.cors));
      for (const { url, cors } of attempts) {
        try {
          await this.player.start(url, { volume: this._vol(st.volume), timeoutMs: this.config.startTimeoutMs, cors });
          playing = url;
          (this.music.goodCors ||= {})[st.name] = { cors };
          break;
        } catch (err) {
          if (op !== this.op || err?.superseded) return;
          errors.push(`${url}${cors ? ' [cors]' : ''} (${errText(err)})`);
        }
      }
      if (!playing) {
        this._log('source_failed', { detail: `${st.name}: ${errors.join('; ')}` });
        continue;
      }
      if (op !== this.op) return;
      this.music.idx = i;
      (this.music.goodUrl ||= {})[st.name] = playing;
      this._persist();
      this._setMode('music', { kind: 'music', label: st.name, key: `music:${st.name}` });
      this._log('source_started', { detail: playing });
      return;
    }
    return this._allFailed(op, 'music: no station would play');
  }

  async _podcast(op, isNext) {
    this._savePodcastPosition();
    this.player.stop();
    this._setMode('podcast', null);

    if (this._shouldCue(isNext)) {
      await this.cues.play('podcast');
      if (op !== this.op) return;
    }

    const shows = this.getShows().filter((s) => s.episodes?.length);
    if (!shows.length) return this._allFailed(op, 'podcast: no episodes loaded');

    const curIdx = Math.max(0, shows.findIndex((s) => s.key === this.podcast.showKey));
    let plan;
    if (isNext) plan = { showIdx: (curIdx + 1) % shows.length, resume: false };
    else if (this.podcast.episode && !this.podcast.finished) plan = { showIdx: curIdx, resume: true };
    else plan = { showIdx: curIdx, resume: false }; // finished or never played: fresh episode, same show

    await this._tryPodcasts(op, shows, plan);
  }

  async _tryPodcasts(op, shows, { showIdx, resume }) {
    const n = shows.length;
    let attempts = 0;
    let idx = showIdx;

    if (resume && this.podcast.episode) {
      attempts++;
      const ep = this.podcast.episode;
      const show = shows.find((s) => s.key === ep.showKey);
      const ok = await this._startEpisode(op, ep, show, this.podcast.position);
      if (ok !== false) return; // started, or superseded
      idx = (idx + 1) % n;
    }

    // Fresh episodes: try each show once (and the resume show again, with a different episode).
    for (let k = 0; k < n; k++) {
      const show = shows[(idx + k) % n];
      const pick = this._pickEpisode(show);
      if (!pick) continue;
      const ep = { url: pick.url, title: pick.title, showKey: show.key, showName: show.name };
      const ok = await this._startEpisode(op, ep, show, 0);
      if (ok !== false) return;
    }
    return this._allFailed(op, 'podcast: no episode would play');
  }

  // Returns true on success, false on failure, undefined if superseded.
  async _startEpisode(op, ep, show, position) {
    const label = `${ep.showName} — ${ep.title}`;
    try {
      await this.player.start(ep.url, {
        volume: this._vol(show?.volume),
        startAt: position,
        timeoutMs: this.config.startTimeoutMs,
      });
    } catch (err) {
      if (op !== this.op || err?.superseded) return undefined;
      this._log('source_failed', { detail: `${label}: ${errText(err)}` });
      this._remember(ep); // don't pick a broken episode again soon
      return false;
    }
    if (op !== this.op) return undefined;
    this.podcast = { showKey: ep.showKey, episode: ep, position, finished: false };
    this._remember(ep);
    this._persist();
    this._setMode('podcast', { kind: 'podcast', label, key: `podcast:${ep.url}` });
    this._log('source_started', { detail: position > 5 ? `resumed at ${fmtTime(position)}` : ep.url });
    return true;
  }

  _allFailed(op, why) {
    if (op !== this.op) return;
    this.player.stop();
    this._setMode('silence', null);
    this._log('all_failed', { detail: why });
  }

  // ---- events from the player -----------------------------------------

  _handleEnded() {
    if (this.mode === 'podcast' && this.current?.kind === 'podcast') {
      this._log('episode_ended', { detail: this._label() });
      this.podcast.finished = true;
      this.podcast.position = 0;
      this._persist();
      const op = ++this.op;
      const how = this.config.podcasts.onEpisodeEnd;
      if (how === 'next-episode' || how === 'next-show') {
        const shows = this.getShows().filter((s) => s.episodes?.length);
        const curIdx = Math.max(0, shows.findIndex((s) => s.key === this.podcast.showKey));
        const showIdx = how === 'next-show' ? (curIdx + 1) % shows.length : curIdx;
        if (shows.length) return this._tryPodcasts(op, shows, { showIdx, resume: false });
      }
      this.player.stop();
      this._setMode('silence', null);
      return;
    }
    // A radio stream "ending" is really a drop.
    if (this.mode === 'music') this._handleDrop(new Error('stream ended'));
  }

  _handleDrop(err) {
    if (!this.current) return;
    const key = this.current.key;
    const t = this.now();
    this.drops = this.drops.filter((d) => t - d.at < RECENT_DROP_WINDOW_MS);
    const recent = this.drops.filter((d) => d.key === key).length;
    this.drops.push({ key, at: t });
    const retrySame = recent < this.config.maxRetriesPerSource;
    this._log('source_dropped', { detail: `${this._label()}: ${errText(err)}; ${retrySame ? 'retrying' : 'moving on'}` });

    const op = ++this.op;
    if (this.mode === 'music') {
      const n = this.config.stations.length;
      return this._tryStations(op, retrySame ? this.music.idx : (this.music.idx + 1) % n);
    }
    if (this.mode === 'podcast') {
      this.podcast.position = Math.max(0, this.player.position - 5);
      this._persist();
      const shows = this.getShows().filter((s) => s.episodes?.length);
      if (!shows.length) return this._allFailed(op, 'podcast: no episodes loaded');
      const curIdx = Math.max(0, shows.findIndex((s) => s.key === this.podcast.showKey));
      return retrySame
        ? this._tryPodcasts(op, shows, { showIdx: curIdx, resume: true })
        : this._tryPodcasts(op, shows, { showIdx: (curIdx + 1) % shows.length, resume: false });
    }
  }

  // ---- helpers -------------------------------------------------------------

  _shouldCue(isNext) {
    const w = this.config.cueWhen;
    return w === 'always' || (w !== 'never' && !isNext);
  }

  _pickEpisode(show) {
    const recent = show.episodes.slice(0, this.config.podcasts.recentCount || 10);
    const played = new Set(this.played[show.key] || []);
    const fresh = recent.filter((e) => !played.has(e.url));
    const pool = fresh.length ? fresh : recent;
    if (!pool.length) return null;
    if (this.config.podcasts.pick === 'newest') return pool[0];
    return pool[Math.floor(this.random() * pool.length)];
  }

  _remember(ep) {
    const list = (this.played[ep.showKey] ||= []);
    if (!list.includes(ep.url)) list.unshift(ep.url);
    list.length = Math.min(list.length, 30);
  }

  _savePodcastPosition() {
    if (this.mode === 'podcast' && this.current?.kind === 'podcast') {
      this.podcast.position = this.player.position;
      this._persist();
    }
  }

  _persist() {
    this.storage.set('state', { music: this.music, podcast: this.podcast, played: this.played });
  }

  _vol(v) {
    return Math.max(0, Math.min(1, (v ?? 1) * (this.config.masterVolume ?? 1)));
  }

  _label() {
    return this.current?.label ?? '';
  }

  _setMode(mode, current) {
    this.mode = mode;
    this.current = current;
    this.onChange(this);
  }

  _log(event, fields = {}) {
    this.logger.log({ event, mode_after: this.mode, source_after: this._label(), ...fields });
  }
}

function errText(err) {
  return err?.message || String(err);
}

function fmtTime(s) {
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
