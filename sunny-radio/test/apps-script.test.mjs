// Runs apps-script/Code.gs in Node against small fakes of the Google services
// it uses, to check the update/serve/log logic without a real Google account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function fakeSheet(name) {
  const data = []; // rows of cells
  const sheet = {
    name,
    data,
    getLastRow: () => {
      for (let r = data.length - 1; r >= 0; r--) if ((data[r] || []).some((c) => c !== '' && c != null)) return r + 1;
      return 0;
    },
    getMaxRows: () => Math.max(1000, data.length),
    setFrozenRows() {},
    getRange(row, col, numRows = 1, numCols = 1) {
      if (typeof row === 'string') return { setNumberFormat() {} };
      return {
        setNumberFormat() {},
        setValues(values) {
          assert.equal(values.length, numRows, 'row count mismatch');
          values.forEach((v, i) => {
            assert.equal(v.length, numCols, 'col count mismatch');
            const r = (data[row - 1 + i] ||= []);
            v.forEach((cell, j) => (r[col - 1 + j] = cell));
          });
        },
        getValues() {
          return Array.from({ length: numRows }, (_, i) =>
            Array.from({ length: numCols }, (_, j) => (data[row - 1 + i] || [])[col - 1 + j] ?? ''),
          );
        },
        clearContent() {
          for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) if (data[row - 1 + i]) data[row - 1 + i][col - 1 + j] = '';
        },
      };
    },
  };
  return sheet;
}

function makeEnv(feeds) {
  const sheets = {};
  const props = {};
  const triggers = [];
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = fakeSheet(n)),
      }),
    },
    UrlFetchApp: {
      fetch(url) {
        const f = feeds[url];
        if (!f) throw new Error('DNS error: ' + url);
        return { getResponseCode: () => f.code ?? 200, getContentText: () => f.text };
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyHours: (h) => ({ create: () => triggers.push({ fn, h, getHandlerFunction: () => fn }) }) }) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, sheets, triggers, props };
}

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items
  .map(([t, u, d]) => `<item><title>${t}</title><pubDate>${d}</pubDate><enclosure url="${u}" type="audio/mpeg"/></item>`)
  .join('')}</channel></rss>`;

const FEEDS = {
  'https://feeds.simplecast.com/BqbsxVfO': { text: rss([['Old', 'https://a/1.mp3', 'Mon, 05 Oct 2026 08:00:00 +0000'], ['New', 'https://a/2.mp3', 'Tue, 13 Oct 2026 08:00:00 +0000']]) },
  'https://feeds.npr.org/381444908/podcast.xml': { text: rss([['FA', 'https://b/1.mp3', 'Sat, 17 Oct 2026 11:00:00 +0000']]) },
};

test('setup seeds shows, installs one timer, fetches episodes', () => {
  const env = makeEnv({ ...FEEDS });
  env.ctx.setup();
  env.ctx.setup(); // re-running must not stack triggers
  assert.equal(env.triggers.length, 1);
  assert.equal(env.triggers[0].fn, 'updateEpisodes');
  assert.equal(env.triggers[0].h, 4);

  const pod = env.sheets.podcasts.data;
  assert.deepEqual(pod[0], ['name', 'feed', 'volume', 'enabled', 'status', 'last_checked', 'episodes']);
  assert.equal(pod[1][4], 'ok');
  assert.equal(pod[1][6], 2);
  assert.equal(env.sheets.episodes.getLastRow(), 4); // header + 3 episodes
  assert.ok(env.sheets.log);
  assert.ok(env.props.episodesUpdatedAt);
});

test('doGet serves enabled shows with newest-first episodes and volume', () => {
  const env = makeEnv({ ...FEEDS });
  env.ctx.setup();
  const pod = env.sheets.podcasts;
  pod.getRange(3, 3, 1, 2).setValues([[0.6, 'no']]); // Fresh Air: volume 0.6, disabled
  pod.getRange(2, 3, 1, 1).setValues([['']]); // blank volume -> 1
  const out = JSON.parse(env.ctx.doGet({ parameter: {} }).text);
  assert.equal(out.ok, true);
  assert.equal(out.shows.length, 1);
  assert.equal(out.shows[0].name, '99% Invisible');
  assert.equal(out.shows[0].volume, 1);
  assert.deepEqual(out.shows[0].episodes.map((e) => e.title), ['New', 'Old']);
  assert.equal(out.shows[0].key, 'https://feeds.simplecast.com/BqbsxVfO');
});

test('a failing feed keeps its previous episodes and reports the error', () => {
  const feeds = { ...FEEDS };
  const env = makeEnv(feeds);
  env.ctx.setup();
  feeds['https://feeds.npr.org/381444908/podcast.xml'] = { code: 503, text: 'down' };
  delete feeds['https://feeds.simplecast.com/BqbsxVfO']; // network error
  env.ctx.updateEpisodes();
  const pod = env.sheets.podcasts.data;
  assert.match(pod[1][4], /^error: DNS error.*kept previous episodes/);
  assert.match(pod[2][4], /^error: HTTP 503.*kept previous/);
  const out = JSON.parse(env.ctx.doGet({}).text);
  assert.equal(out.shows[0].episodes.length, 2);
  assert.equal(out.shows[1].episodes.length, 1);
});

test('a show added later gets fetched; removed rows drop out', () => {
  const feeds = { ...FEEDS, 'https://new/feed': { text: rss([['N1', 'https://n/1.mp3', 'Fri, 16 Oct 2026 08:00:00 +0000']]) } };
  const env = makeEnv(feeds);
  env.ctx.setup();
  env.sheets.podcasts.getRange(4, 1, 1, 4).setValues([['New Show', 'https://new/feed', 0.9, true]]);
  env.sheets.podcasts.getRange(2, 1, 1, 4).clearContent(); // delete 99PI by clearing its row
  env.ctx.updateEpisodes();
  const out = JSON.parse(env.ctx.doGet({}).text);
  assert.deepEqual(out.shows.map((s) => s.name), ['Fresh Air', 'New Show']);
  assert.equal(out.shows[1].volume, 0.9);
});

test('doPost appends log rows and skips duplicates', () => {
  const env = makeEnv({ ...FEEDS });
  env.ctx.setup();
  const rows = [{ id: 'x1', event: 'press', button: 'music' }, { id: 'x2', event: 'source_started', detail: '=not a formula' }];
  let res = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ rows }) } }).text);
  assert.deepEqual([res.ok, res.added], [true, 2]);
  res = JSON.parse(env.ctx.doPost({ postData: { contents: JSON.stringify({ rows: [...rows, { id: 'x3', event: 'press' }] }) } }).text);
  assert.equal(res.added, 1);
  const log = env.sheets.log.data;
  assert.equal(log.length, 4);
  assert.equal(log[1][3], 'press');
  assert.equal(log[1][5], 'music');
  res = JSON.parse(env.ctx.doPost({ postData: { contents: 'garbage' } }).text);
  assert.equal(res.ok, false);
});

test('parseFeed: entities, CDATA, itunes:title ignored, non-audio skipped', () => {
  const { ctx } = makeEnv({});
  const xml = `<rss><channel><title>A &amp; B</title>
    <item><itunes:title>no</itunes:title><title><![CDATA[Older <ep>]]></title><pubDate>Mon, 05 Oct 2026 08:00:00 +0000</pubDate>
      <enclosure url="https://c/a.mp3?x=1&amp;y=2" type="audio/mpeg"/></item>
    <item><title>Newer &#8212; 2</title><pubDate>Tue, 13 Oct 2026 08:00:00 +0000</pubDate><enclosure type='audio/x-m4a' url='https://c/b.m4a'/></item>
    <item><title>Video</title><enclosure url="https://c/v.mp4" type="video/mp4"/></item>
  </channel></rss>`;
  const r = ctx.parseFeed(xml, 20);
  assert.equal(r.title, 'A & B');
  assert.deepEqual(Array.from(r.episodes, (e) => e.title), ['Newer — 2', 'Older <ep>']);
  assert.equal(r.episodes[1].url, 'https://c/a.mp3?x=1&y=2');
  assert.throws(() => ctx.parseFeed('<html></html>'));
});
