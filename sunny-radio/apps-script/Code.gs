// Sunny Radio: Google Apps Script backend.
//
// One web app URL does two jobs:
//   GET  -> the current podcast episode list (the Chromebook app loads this)
//   POST -> log rows from the app (appended to the "log" tab)
//
// Tabs it uses (created by setup()):
//   podcasts : the show list you edit. Columns: name | feed | volume | enabled | status | last_checked | episodes
//              (you edit A-D; the script fills in E-G)
//   episodes : recent episodes per show, rewritten on every update. Don't edit; it's overwritten.
//   log      : event log from the app.
//
// First-time setup: paste this file in, pick "setup" in the function dropdown, click Run,
// approve the permissions, then Deploy -> New deployment -> Web app (Execute as: Me,
// Who has access: Anyone). See the README for details.

const MAX_EPISODES_PER_SHOW = 20;
const UPDATE_EVERY_HOURS = 4;

const LOG_SHEET = 'log';
const LOG_COLUMNS = [
  'id', 'timestamp_utc', 'local_time', 'event', 'input', 'button',
  'mode_before', 'mode_after', 'source_before', 'source_after', 'detail',
];
const PODCAST_SHEET = 'podcasts';
const PODCAST_COLUMNS = ['name', 'feed', 'volume', 'enabled', 'status', 'last_checked', 'episodes'];
const EPISODE_SHEET = 'episodes';
const EPISODE_COLUMNS = ['show_feed', 'show_name', 'title', 'url', 'published'];

const STARTER_SHOWS = [
  ['99% Invisible', 'https://feeds.simplecast.com/BqbsxVfO', 1, true],
  ['Fresh Air', 'https://feeds.npr.org/381444908/podcast.xml', 1, true],
];

// ---------------------------------------------------------------------------
// Setup and menu

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pod = sheet_(ss, PODCAST_SHEET, PODCAST_COLUMNS);
  if (pod.getLastRow() < 2) {
    pod.getRange(2, 1, STARTER_SHOWS.length, 4).setValues(STARTER_SHOWS);
  }
  sheet_(ss, EPISODE_SHEET, EPISODE_COLUMNS, true);
  logSheet_(ss);

  // Exactly one timed trigger for updateEpisodes.
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'updateEpisodes')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('updateEpisodes').timeBased().everyHours(UPDATE_EVERY_HOURS).create();

  updateEpisodes();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sunny Radio')
    .addItem('Update podcasts now', 'updateEpisodes')
    .addItem('Re-run setup', 'setup')
    .addToUi();
}

// ---------------------------------------------------------------------------
// Podcast updating (runs on the timer, from the menu, or from setup)

function updateEpisodes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pod = sheet_(ss, PODCAST_SHEET, PODCAST_COLUMNS);
  const epSheet = sheet_(ss, EPISODE_SHEET, EPISODE_COLUMNS, true);
  const shows = readShows_(pod);
  const previous = readEpisodes_(epSheet);
  const now = new Date();

  const newRows = [];
  const statuses = []; // per podcasts-tab row: [status, last_checked, episodes]

  shows.forEach((show) => {
    if (!show.feed) {
      statuses.push({ row: show.row, values: ['', '', ''] });
      return;
    }
    if (!show.enabled) {
      statuses.push({ row: show.row, values: ['disabled', '', ''] });
      return;
    }
    let episodes;
    let status;
    try {
      const res = UrlFetchApp.fetch(show.feed, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'SunnyRadio/1.0 (personal podcast player)' },
      });
      const code = res.getResponseCode();
      if (code !== 200) throw new Error('HTTP ' + code);
      episodes = parseFeed(res.getContentText(), MAX_EPISODES_PER_SHOW).episodes;
      if (!episodes.length) throw new Error('no audio episodes found');
      status = 'ok';
    } catch (err) {
      episodes = previous[show.feed] || [];
      status = 'error: ' + (err && err.message ? err.message : err) + (episodes.length ? ' (kept previous episodes)' : '');
    }
    episodes.forEach((ep) => newRows.push([show.feed, show.name, ep.title, ep.url, ep.published || '']));
    statuses.push({ row: show.row, values: [status, now, episodes.length] });
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (epSheet.getLastRow() > 1) epSheet.getRange(2, 1, epSheet.getLastRow() - 1, EPISODE_COLUMNS.length).clearContent();
    if (newRows.length) epSheet.getRange(2, 1, newRows.length, EPISODE_COLUMNS.length).setValues(newRows);
    statuses.forEach((s) => pod.getRange(s.row, 5, 1, 3).setValues([s.values]));
    PropertiesService.getScriptProperties().setProperty('episodesUpdatedAt', now.toISOString());
  } finally {
    lock.releaseLock();
  }
}

function readShows_(pod) {
  const last = pod.getLastRow();
  if (last < 2) return [];
  return pod.getRange(2, 1, last - 1, 4).getValues().map((r, i) => {
    const enabledCell = String(r[3]).trim().toLowerCase();
    const vol = parseFloat(r[2]);
    return {
      row: i + 2,
      name: String(r[0]).trim(),
      feed: String(r[1]).trim(),
      volume: isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1,
      enabled: !(r[3] === false || enabledCell === 'false' || enabledCell === 'no' || enabledCell === 'n'),
    };
  });
}

function readEpisodes_(epSheet) {
  const out = {};
  const last = epSheet.getLastRow();
  if (last < 2) return out;
  epSheet.getRange(2, 1, last - 1, EPISODE_COLUMNS.length).getValues().forEach((r) => {
    const feed = String(r[0]);
    if (!feed) return;
    (out[feed] = out[feed] || []).push({ title: String(r[2]), url: String(r[3]), published: String(r[4]) || null });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Web app

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shows = readShows_(sheet_(ss, PODCAST_SHEET, PODCAST_COLUMNS));
  const eps = readEpisodes_(sheet_(ss, EPISODE_SHEET, EPISODE_COLUMNS, true));
  const out = {
    ok: true,
    generatedAt: PropertiesService.getScriptProperties().getProperty('episodesUpdatedAt'),
    shows: shows
      .filter((s) => s.enabled && s.feed)
      .map((s) => ({ key: s.feed, name: s.name || s.feed, volume: s.volume, episodes: eps[s.feed] || [] })),
  };
  return json_(out);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = JSON.parse(e.postData.contents).rows || [];
    const sheet = logSheet_(SpreadsheetApp.getActiveSpreadsheet());

    // Skip ids we already have (the app resends anything it wasn't sure got through).
    const last = sheet.getLastRow();
    const lookback = Math.min(Math.max(last - 1, 0), 5000);
    const seen = {};
    if (lookback) sheet.getRange(last - lookback + 1, 1, lookback, 1).getValues().forEach((r) => (seen[r[0]] = true));
    const fresh = rows.filter((r) => r && r.id && !seen[r.id]);
    if (fresh.length) {
      const values = fresh.map((r) => LOG_COLUMNS.map((c) => (r[c] == null ? '' : String(r[c]))));
      sheet.getRange(last + 1, 1, values.length, LOG_COLUMNS.length).setValues(values);
    }
    return json_({ ok: true, received: rows.length, added: fresh.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// RSS parsing. Podcast RSS is regular enough that pulling out <item> blocks and
// their <enclosure>, <title> and <pubDate> works without a strict XML parser
// (which would reject the slightly-broken feeds that are common in the wild).

function parseFeed(xml, max) {
  max = max || 20;
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error('not an RSS feed');
  const channelHead = xml.split(/<item[\s>]/i)[0];
  const title = tagText_(channelHead, 'title');
  const episodes = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const item = m[0];
    const encRe = /<enclosure\b([^>]*)>/gi;
    let em;
    let enc = null;
    while ((em = encRe.exec(item))) {
      const a = attrs_(em[1]);
      if (/^audio\//i.test(a.type || '') || /\.(mp3|m4a|aac|ogg|opus)(\?|$)/i.test(a.url || '')) {
        enc = a;
        break;
      }
    }
    if (!enc || !enc.url) continue;
    const published = new Date(tagText_(item, 'pubDate'));
    episodes.push({
      title: tagText_(item, 'title') || '(untitled)',
      url: enc.url,
      published: isNaN(published.getTime()) ? null : published.toISOString(),
    });
  }
  episodes.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  return { title: title, episodes: episodes.slice(0, max) };
}

function tagText_(xml, tag) {
  // Plain <tag>, not <itunes:tag>
  const m = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  v = cdata ? cdata[1] : decode_(v);
  return v.replace(/\s+/g, ' ').trim();
}

function attrs_(s) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = decode_(m[3] != null ? m[3] : m[4]);
  return out;
}

function decode_(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Helpers

// plainText: store everything as text, so Sheets doesn't reformat ids, dates or
// URLs, and never treats a title starting with "=" as a formula.
function sheet_(ss, name, columns, plainText) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    if (plainText) sh.getRange(1, 1, sh.getMaxRows(), columns.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, columns.length).setValues([columns]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function logSheet_(ss) {
  return sheet_(ss, LOG_SHEET, LOG_COLUMNS, true);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
