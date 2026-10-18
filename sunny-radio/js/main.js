import config from './config.js';
import { AudioOutput } from './audio.js';
import { Cues } from './cues.js';
import { Logger } from './logger.js';
import { Controller } from './controller.js';
import { createStorage } from './storage.js';

const storage = createStorage();
const $ = (sel) => document.querySelector(sel);

// ---- device-local settings (override config.js without a redeploy) ----
const local = storage.get('settings') || {};
if (Number.isFinite(local.debounceMs)) config.debounceMs = local.debounceMs;
const getEndpoint = () => local.sheetUrl || config.sheetUrl || '';

// ---- podcast episodes -------------------------------------------------
let episodes = storage.get('episodes'); // last good copy, used if the fetch fails

let episodesError = null;

async function loadEpisodes() {
  const url = getEndpoint();
  if (!url) {
    episodesError = 'Sheet URL not set';
    return render();
  }
  try {
    // Plain GET with no custom headers: Apps Script can't answer CORS preflights.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.shows)) throw new Error(data.error || 'unexpected reply');
    episodes = data;
    episodesError = null;
    storage.set('episodes', data);
  } catch (err) {
    episodesError = err?.message || String(err);
    console.warn('podcast list not loaded:', err);
  }
  render();
}

// ---- wiring -----------------------------------------------------------
const player = new AudioOutput();
player.stallTimeoutMs = config.stallTimeoutMs;
const cues = new Cues(config);
const logger = new Logger({ storage, getEndpoint });
const controller = new Controller({
  config,
  player,
  cues,
  logger,
  storage,
  getShows: () => episodes?.shows || [],
  onChange: () => render(),
});
logger.onChange(() => render());

// Pedal = keyboard. Holding a pedal down auto-repeats; ignore repeats.
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  if ($('#settings').open) return;
  const key = e.key.toLowerCase();
  const button = config.keys[key];
  if (!button) return;
  e.preventDefault();
  flash(button);
  controller.press(button, `pedal:${key}`);
});

// On-screen buttons (for humans; logged separately as input "screen").
document.querySelectorAll('[data-button]').forEach((el) =>
  el.addEventListener('click', () => {
    flash(el.dataset.button);
    controller.press(el.dataset.button, 'screen');
  }),
);

// Focus watch: if the page loses focus, pedal presses go elsewhere.
let hadFocus = null;
function checkFocus() {
  const f = document.hasFocus();
  if (f !== hadFocus) {
    if (hadFocus !== null) logger.log({ event: f ? 'focus_gained' : 'focus_lost', mode_after: controller.mode });
    hadFocus = f;
    $('#focus-banner').hidden = f;
  }
}
window.addEventListener('focus', checkFocus);
window.addEventListener('blur', checkFocus);
setInterval(checkFocus, 2000);

setInterval(() => controller.tick(), 5000);
setInterval(() => logger.flush(), 30000);
setInterval(loadEpisodes, (config.podcasts.refreshMinutes || 60) * 60000);
window.addEventListener('online', () => logger.flush());

// ---- settings panel ---------------------------------------------------
const dlg = $('#settings');
$('#open-settings').addEventListener('click', () => {
  $('#set-endpoint').value = getEndpoint();
  $('#set-debounce').value = config.debounceMs;
  $('#set-status').textContent = '';
  dlg.showModal();
});
$('#save-settings').addEventListener('click', () => {
  local.sheetUrl = $('#set-endpoint').value.trim();
  const d = parseInt($('#set-debounce').value, 10);
  if (Number.isFinite(d) && d >= 0) local.debounceMs = config.debounceMs = d;
  storage.set('settings', local);
  $('#set-status').textContent = 'Saved.';
  logger.flush();
  loadEpisodes();
  render();
});
$('#test-log').addEventListener('click', async () => {
  $('#set-status').textContent = 'Sending…';
  logger.log({ event: 'test', input: 'screen', detail: 'test row from settings panel' });
  await logger.flush();
  $('#set-status').textContent = logger.status.lastError
    ? `Failed: ${logger.status.lastError}`
    : 'Sent. Check the sheet for a "test" row.';
});
$('#export-csv').addEventListener('click', () => {
  const blob = new Blob([logger.toCSV()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sunny-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#close-settings').addEventListener('click', () => dlg.close());

// ---- rendering --------------------------------------------------------
const MODE_WORDS = { silence: 'Quiet', music: 'Music', podcast: 'Podcast' };

function flash(button) {
  const el = document.querySelector(`[data-button="${button}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function render() {
  const mode = controller.mode;
  document.body.dataset.mode = mode;
  $('#mode').textContent = MODE_WORDS[mode];
  $('#source').textContent = controller.current?.label || (mode === 'silence' ? '' : 'Starting…');
  document.querySelectorAll('[data-button]').forEach((el) => el.classList.toggle('active', el.dataset.button === mode));

  const rows = logger.history.slice(-12).reverse();
  $('#activity').innerHTML = rows
    .map((r) => `<li class="ev-${esc(r.event)}"><time>${esc(r.local_time.slice(11, 16))}</time><span>${esc(describe(r))}</span></li>`)
    .join('');

  const ep = getEndpoint();
  const s = logger.status;
  $('#log-status').textContent = !ep
    ? `Sheet logging not set up · ${logger.outbox.length} saved on this device`
    : s.lastError
      ? `Sheet: can't send (${s.lastError}) · ${logger.outbox.length} waiting`
      : `Sheet: ${logger.outbox.length ? `${logger.outbox.length} waiting` : 'up to date'}${s.lastOkAt ? ` · last sent ${s.lastOkAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;

  const shows = episodes?.shows?.filter((x) => x.episodes?.length) || [];
  const updated = episodes?.generatedAt
    ? new Date(episodes.generatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'never';
  $('#ep-status').textContent = episodes
    ? `${shows.length} podcast${shows.length === 1 ? '' : 's'} · feeds checked ${updated}${episodesError ? ` · couldn't refresh (${episodesError}), using saved copy` : ''}`
    : `No podcast list loaded${episodesError ? ` (${episodesError})` : ''}`;
}

function describe(r) {
  const b = { music: 'Music', podcast: 'Podcast', silence: 'Quiet' }[r.button] || r.button;
  switch (r.event) {
    case 'press': return `${r.input.startsWith('pedal') ? 'Pedal' : 'Screen'}: ${b} (${r.detail})`;
    case 'press_ignored': return `${b} pressed too soon, ignored`;
    case 'source_started': return `Playing ${r.source_after}`;
    case 'source_failed': return `Skipped: ${r.detail}`;
    case 'source_dropped': return `Dropped: ${r.detail}`;
    case 'all_failed': return `Nothing would play (${r.detail})`;
    case 'episode_ended': return `Finished ${r.detail}`;
    default: return `${r.event}${r.detail ? `: ${r.detail}` : ''}`;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---- start -----------------------------------------------------------
document.querySelectorAll('.key-a').forEach((el) => (el.textContent = keyFor('music')));
document.querySelectorAll('.key-b').forEach((el) => (el.textContent = keyFor('silence')));
document.querySelectorAll('.key-c').forEach((el) => (el.textContent = keyFor('podcast')));
function keyFor(button) {
  return (Object.entries(config.keys).find(([, v]) => v === button)?.[0] || '').toUpperCase();
}

logger.log({ event: 'app_loaded', mode_after: 'silence', detail: navigator.userAgent });
checkFocus();
render();
loadEpisodes();
