import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../js/logger.js';
import { memoryStorage } from '../js/storage.js';

test('rows queue while offline and send once the endpoint answers ok', async () => {
  let online = false;
  const received = [];
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers, undefined); // must stay a simple request (no CORS preflight)
    if (!online) throw new Error('offline');
    const { rows } = JSON.parse(opts.body);
    received.push(...rows);
    return { json: async () => ({ ok: true }) };
  };
  const storage = memoryStorage();
  const logger = new Logger({ storage, getEndpoint: () => 'https://example/exec', fetchImpl });
  logger.log({ event: 'press', button: 'music' });
  logger.log({ event: 'press', button: 'silence' });
  await logger.flush();
  assert.equal(logger.outbox.length, 2);
  assert.match(logger.status.lastError, /offline/);

  // survives a reload
  const reloaded = new Logger({ storage, getEndpoint: () => 'https://example/exec', fetchImpl });
  assert.equal(reloaded.outbox.length, 2);

  online = true;
  await reloaded.flush();
  assert.equal(reloaded.outbox.length, 0);
  assert.deepEqual(received.map((r) => r.button), ['music', 'silence']);
  assert.ok(received.every((r) => r.id && r.timestamp_utc && r.local_time));
  assert.equal(reloaded.history.length, 2);
});

test('CSV export escapes commas and quotes', () => {
  const logger = new Logger({ storage: memoryStorage(), getEndpoint: () => '' });
  logger.log({ event: 'source_started', source_after: 'Show, "Quoted"' });
  const csv = logger.toCSV().split('\n');
  assert.equal(csv[0].split(',')[0], 'id');
  assert.ok(csv[1].includes('"Show, ""Quoted"""'));
});
