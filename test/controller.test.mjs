import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../js/controller.js';
import { memoryStorage } from '../js/storage.js';

function setup({ bad = [], shows, overrides = {} } = {}) {
  const config = {
    debounceMs: 1500,
    readySound: null,
    cueWhen: 'starting',
    masterVolume: 1,
    stations: [
      { name: 'S0', url: 'radio:0', volume: 1 },
      { name: 'S1', url: 'radio:1', volume: 0.5 },
      { name: 'S2', url: 'radio:2', volume: 1 },
    ],
    podcasts: { pick: 'newest', recentCount: 10, onEpisodeEnd: 'silence' },
    startTimeoutMs: 1000,
    maxRetriesPerSource: 1,
    ...overrides,
  };
  const player = {
    calls: [], position: 0, ended: null, failure: null, playing: null,
    onEnded(cb) { this.ended = cb; }, onFailure(cb) { this.failure = cb; },
    async start(url, opts) {
      this.calls.push({ url, ...opts });
      if (bad.includes(url)) throw new Error('nope');
      this.playing = url;
      this.position = opts.startAt || 0;
    },
    stop() { this.playing = null; },
  };
  const cueLog = [];
  const cues = { async play(n) { cueLog.push(n); }, stop() {}, ready() { cueLog.push('ready'); } };
  const rows = [];
  const logger = { log: (r) => rows.push(r) };
  let t = 100000;
  const storage = memoryStorage();
  const showList = shows ?? [
    { key: 'A', name: 'Show A', volume: 1, episodes: [{ url: 'a:1', title: 'A1' }, { url: 'a:2', title: 'A2' }] },
    { key: 'B', name: 'Show B', volume: 0.8, episodes: [{ url: 'b:1', title: 'B1' }] },
  ];
  const mk = () => new Controller({ config, player, cues, logger, storage, getShows: () => showList, now: () => t, random: () => 0 });
  const c = mk();
  const press = async (b) => { t += 5000; await c.press(b, 'test'); };
  return { c, player, cueLog, rows, press, advance: (ms) => (t += ms), mk, storage, config };
}

test('music: first press cues and plays station 0; second press goes to next without cue', async () => {
  const { c, player, cueLog, press } = setup();
  await press('music');
  assert.equal(c.mode, 'music');
  assert.equal(player.playing, 'radio:0');
  assert.deepEqual(cueLog, ['music']);
  await press('music');
  assert.equal(player.playing, 'radio:1');
  assert.equal(player.calls.at(-1).volume, 0.5);
  assert.deepEqual(cueLog, ['music']);
});

test('silence says all done; music after silence resumes the same station', async () => {
  const { c, player, cueLog, press } = setup();
  await press('music');
  await press('music'); // S1
  await press('silence');
  assert.equal(c.mode, 'silence');
  assert.equal(player.playing, null);
  assert.equal(cueLog.at(-1), 'silence');
  await press('music');
  assert.equal(player.playing, 'radio:1');
  assert.equal(cueLog.at(-1), 'music');
});

test('dead stations are skipped and logged', async () => {
  const { player, rows, press } = setup({ bad: ['radio:0', 'radio:1'] });
  await press('music');
  assert.equal(player.playing, 'radio:2');
  assert.equal(rows.filter((r) => r.event === 'source_failed').length, 2);
});

test('all stations dead -> silence + all_failed', async () => {
  const { c, rows, press } = setup({ bad: ['radio:0', 'radio:1', 'radio:2'] });
  await press('music');
  assert.equal(c.mode, 'silence');
  assert.ok(rows.some((r) => r.event === 'all_failed'));
});

test('debounce ignores fast presses and logs them', async () => {
  const { c, player, rows, press } = setup();
  await press('music');
  await c.press('music', 'test'); // same instant
  assert.equal(player.playing, 'radio:0');
  assert.ok(rows.some((r) => r.event === 'press_ignored'));
});

test('podcast resumes the same episode at its position after music or silence', async () => {
  const { c, player, press } = setup();
  await press('podcast');
  assert.equal(player.playing, 'a:1');
  player.position = 600;
  await press('music');
  assert.equal(c.podcast.position, 600);
  await press('podcast');
  assert.equal(player.playing, 'a:1');
  assert.equal(player.calls.at(-1).startAt, 600);
  player.position = 900;
  await press('silence');
  await press('podcast');
  assert.equal(player.calls.at(-1).startAt, 900);
});

test('podcast while podcast plays -> next show, fresh episode', async () => {
  const { player, cueLog, press } = setup();
  await press('podcast');
  await press('podcast');
  assert.equal(player.playing, 'b:1');
  assert.equal(player.calls.at(-1).startAt, 0);
  assert.equal(player.calls.at(-1).volume, 0.8);
  assert.deepEqual(cueLog, ['podcast']);
  await press('podcast'); // back to A: should not repeat a:1
  assert.equal(player.playing, 'a:2');
});

test('episode end -> silence; next press plays a new episode of the same show', async () => {
  const { c, player, press } = setup();
  await press('podcast');
  player.ended();
  assert.equal(c.mode, 'silence');
  await press('podcast');
  assert.equal(player.playing, 'a:2');
});

test('onEpisodeEnd next-show keeps playing', async () => {
  const { c, player, press, config } = setup();
  config.podcasts.onEpisodeEnd = 'next-show';
  await press('podcast');
  await player.ended();
  assert.equal(c.mode, 'podcast');
  assert.equal(player.playing, 'b:1');
});

test('broken episode is skipped to another show', async () => {
  const { player, press } = setup({ bad: ['a:1'] });
  await press('podcast');
  assert.equal(player.playing, 'b:1');
});

test('no episodes loaded -> silence + all_failed', async () => {
  const { c, rows, press } = setup({ shows: [] });
  await press('podcast');
  assert.equal(c.mode, 'silence');
  assert.equal(rows.at(-1).event, 'all_failed');
});

test('stream drop retries same station once, then moves on', async () => {
  const { player, rows, press } = setup();
  await press('music');
  await player.failure(new Error('stalled'));
  assert.equal(player.playing, 'radio:0');
  await player.failure(new Error('stalled'));
  assert.equal(player.playing, 'radio:1');
  assert.equal(rows.filter((r) => r.event === 'source_dropped').length, 2);
});

test('a newer press supersedes an in-flight start', async () => {
  const { c, player, press } = setup();
  let release;
  const origStart = player.start.bind(player);
  player.start = (url, opts) => {
    if (url === 'radio:0') {
      player.calls.push({ url, ...opts });
      return new Promise((_, rej) => { release = () => rej(Object.assign(new Error('superseded'), { superseded: true })); });
    }
    return origStart(url, opts);
  };
  const p1 = press('music');
  await new Promise((r) => setImmediate(r));
  await press('podcast');
  release();
  await p1;
  assert.equal(c.mode, 'podcast');
  assert.equal(player.playing, 'a:1');
});

test('state survives a reload (station and podcast position)', async () => {
  const { c, player, press, mk } = setup();
  await press('music');
  await press('music'); // S1
  await press('podcast');
  player.position = 1234;
  c.tick();
  const c2 = mk();
  assert.equal(c2.music.idx, 1);
  assert.equal(c2.podcast.episode.url, 'a:1');
  assert.equal(c2.podcast.position, 1234);
});

test('press rows record before/after mode', async () => {
  const { rows, press } = setup();
  await press('music');
  const r = rows.find((x) => x.event === 'press');
  assert.equal(r.mode_before, 'silence');
  assert.equal(r.mode_after, 'music');
  assert.equal(r.button, 'music');
});
