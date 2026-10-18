// Event log. Every row is kept locally (outbox) until the Google Sheet
// endpoint confirms it, so nothing is lost while the internet is down.
// Rows carry an id; the Apps Script skips ids it already has, so resends
// never duplicate.

export const COLUMNS = [
  'id', 'timestamp_utc', 'local_time', 'event', 'input', 'button',
  'mode_before', 'mode_after', 'source_before', 'source_after', 'detail',
];

export class Logger {
  constructor({ storage, getEndpoint, fetchImpl = (...a) => fetch(...a), historyMax = 3000, outboxMax = 20000 }) {
    Object.assign(this, { storage, getEndpoint, fetchImpl, historyMax, outboxMax });
    this.history = storage.get('history') || [];
    this.outbox = storage.get('outbox') || [];
    this.status = { lastOkAt: null, lastError: null };
    this._inflight = false;
    this._listeners = [];
  }

  onChange(cb) { this._listeners.push(cb); }

  log(fields) {
    const d = new Date();
    const row = { id: makeId(), timestamp_utc: d.toISOString(), local_time: localTime(d) };
    for (const c of COLUMNS) if (!(c in row)) row[c] = fields[c] ?? '';
    this.history.push(row);
    if (this.history.length > this.historyMax) this.history.splice(0, this.history.length - this.historyMax);
    this.outbox.push(row);
    if (this.outbox.length > this.outboxMax) this.outbox.splice(0, this.outbox.length - this.outboxMax);
    this._save();
    this._emit();
    queueMicrotask(() => this.flush());
    return row;
  }

  async flush() {
    const url = this.getEndpoint();
    if (!url || this._inflight || !this.outbox.length) return;
    this._inflight = true;
    const batch = this.outbox.slice(0, 200);
    try {
      // text/plain body = "simple" request: no CORS preflight, which Apps Script can't answer.
      const res = await this.fetchImpl(url, { method: 'POST', body: JSON.stringify({ rows: batch }) });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || 'endpoint said not ok');
      const sent = new Set(batch.map((r) => r.id));
      this.outbox = this.outbox.filter((r) => !sent.has(r.id));
      this.status = { lastOkAt: new Date(), lastError: null };
      this._save();
    } catch (err) {
      this.status = { ...this.status, lastError: err?.message || String(err) };
    } finally {
      this._inflight = false;
      this._emit();
    }
    if (this.outbox.length && !this.status.lastError) return this.flush();
  }

  toCSV() {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [COLUMNS.join(','), ...this.history.map((r) => COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
  }

  _save() {
    this.storage.set('history', this.history);
    this.storage.set('outbox', this.outbox);
  }

  _emit() {
    for (const cb of this._listeners) cb(this);
  }
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function localTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
