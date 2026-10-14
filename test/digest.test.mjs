import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aggregate, buildManifest, closedDay, MAX_BYTES, MAX_EVENTS } from '../src/events.mjs';
import { loadConnection, destinationHash } from '../src/config.mjs';
import { sendDigest } from '../src/cli.mjs';
import { runDigest } from '../src/digest.mjs';
import { readJson, writeJsonNew } from '../src/storage.mjs';

const day = '2026-01-01';
const now = () => new Date('2026-01-02T08:00:00.000Z');
const connection = { token: 'test-token', room: 'TESTROOM', apiUrl: 'http://127.0.0.1:1' };
const event = (id = 'event-1', type = 'signup', at = `${day}T10:00:00.000Z`) => ({ id, at, type });
const encode = (events) => Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));

async function fixture(t, events = [event()]) {
  const directory = await mkdtemp(join(tmpdir(), 'digest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { day, inputDir: join(directory, 'incoming'), stateDir: join(directory, 'state'), connection, now };
  await mkdir(options.inputDir);
  await writeFile(join(options.inputDir, `${day}.ndjson`), encode(events));
  let sends = 0;
  const send = async () => { sends++; return { notificationId: '00000000-0000-0000-0000-000000000001' }; };
  return { options, record: (name) => join(options.stateDir, day, name), sends: () => sends,
    run: (extra = {}) => runDigest({ ...options, send, ...extra }) };
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('aggregation counts fixed types and deduplicates identical events', () => {
  const result = aggregate(encode([event(), event(), event('order-1', 'order'), event('ticket-1', 'support_ticket')]), day);
  assert.deepEqual(result, { counts: { signup: 1, order: 1, support_ticket: 1 }, total: 3, sourceRows: 4, duplicates: 1 });
});

test('strict schema rejects duplicate JSON keys, unknown fields/types, and conflicting IDs', () => {
  for (const row of [
    '{"id":"one","id":"two","type":"signup"}\n',
    JSON.stringify({ ...event(), email: 'private@example.test' }) + '\n',
    JSON.stringify(event('one', 'unknown')) + '\n',
    JSON.stringify({ ...event(), id: 1 }) + '\n',
  ]) assert.throws(() => aggregate(Buffer.from(row), day), /Invalid event/);
  assert.throws(() => aggregate(encode([event(), event('event-1', 'order')]), day), /Conflicting duplicate/);
});

test('UTC day and event times reject open windows, impossible dates, and offsets', () => {
  assert.equal(closedDay(day, now()), day);
  assert.throws(() => closedDay('2026-01-02', now()), /not closed/);
  assert.throws(() => closedDay('2025-02-30', now()), /real UTC/);
  for (const at of ['2026-01-02T00:00:00.000Z', '2026-01-01T10:00:00+00:00', '2026-01-01T24:00:00.000Z', 'not-a-date']) {
    assert.throws(() => aggregate(encode([event('one', 'signup', at)]), day));
  }
});

test('input limits reject oversized, excessive-row, partial-line and invalid UTF-8 exports', () => {
  assert.throws(() => aggregate(Buffer.alloc(MAX_BYTES + 1), day), /2 MiB/);
  assert.throws(() => aggregate(Buffer.from('\n'.repeat(MAX_EVENTS + 1)), day), /10,000/);
  assert.throws(() => aggregate(Buffer.from(JSON.stringify(event())), day), /newline/);
  assert.throws(() => aggregate(Buffer.from([0xff, 0x0a]), day), /UTF-8/);
});

test('a sent window remains sealed and is skipped after restart or changed incoming file', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, 'sent');
  const original = await readFile(f.record('receipt.json'));
  await writeFile(join(f.options.inputDir, `${day}.ndjson`), encode([event('late-order', 'order')]));
  assert.equal((await f.run()).status, 'already-sent');
  assert.equal(f.sends(), 1);
  assert.deepEqual(await readFile(f.record('receipt.json')), original);
  assert.equal((await readJson(f.record('manifest.json'))).summary.counts.signup, 1);
  assert.equal((await readJson(f.record('manifest.json'))).summary.counts.order, 0);
});

test('an empty day gets a durable receipt without sending', async (t) => {
  const f = await fixture(t, []);
  assert.equal((await f.run()).status, 'empty');
  assert.equal((await f.run()).status, 'already-empty');
  assert.equal(f.sends(), 0);
});

test('unknown delivery never automatically retries; explicit retry appends a new attempt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ send: async () => { throw new Error('private transport detail'); } }), /outcome may be unknown/);
  const first = await readFile(f.record('attempt-000001.json'));
  await assert.rejects(f.run(), /prior send attempt/);
  assert.equal(f.sends(), 0);
  assert.equal((await f.run({ retryUnknown: true })).status, 'sent');
  assert.equal(f.sends(), 1);
  assert.deepEqual(await readFile(f.record('attempt-000001.json')), first);
  assert.ok((await readdir(join(f.options.stateDir, day))).includes('attempt-000002.json'));
});

test('manual confirmation resolves an unknown send without sending another ping', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ send: async () => { throw new Error('connection closed after acceptance'); } }));
  assert.equal((await f.run({ confirmSent: true })).status, 'sent');
  assert.equal((await f.run()).status, 'already-sent');
  assert.equal(f.sends(), 0);
  assert.equal((await readJson(f.record('receipt.json'))).confirmedByOperator, true);
});

test('changing destination or sealed bytes blocks the day without sending', async (t) => {
  const f = await fixture(t);
  await f.run();
  await assert.rejects(f.run({ connection: { ...connection, room: 'OTHER' } }), /differs from the manifest/);
  await assert.rejects(f.run({ connection: { ...connection, token: 'replacement' } }), /differs from the manifest/);
  await writeFile(f.record('input.ndjson'), encode([event('changed', 'order')]));
  await assert.rejects(f.run(), /differs from the manifest/);
  assert.equal(f.sends(), 1);
});

test('same-day invocations cannot overlap', async (t) => {
  const f = await fixture(t);
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const active = f.run({ send: async () => { entered(); await new Promise((resolve) => { release = resolve; }); } });
  await started;
  assert.deepEqual(await f.run(), { status: 'locked', sent: 0 });
  release();
  await active;
  assert.equal((await f.run()).status, 'already-sent');
});

test('record publication refuses to replace an existing receipt', async (t) => {
  const f = await fixture(t, []);
  await f.run();
  const before = await readFile(f.record('receipt.json'));
  await assert.rejects(writeJsonNew(f.record('receipt.json'), { status: 'replacement' }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.record('receipt.json')), before);
});

test('only final .ndjson files are ingested, and invalid input never starts a send', async (t) => {
  const f = await fixture(t);
  await rm(join(f.options.inputDir, `${day}.ndjson`));
  await writeFile(join(f.options.inputDir, `${day}.ndjson.part`), encode([event()]));
  await assert.rejects(f.run(), /No closed export/);
  assert.equal(f.sends(), 0);
  await writeFile(join(f.options.inputDir, `${day}.ndjson`), 'incomplete');
  await assert.rejects(f.run(), /newline/);
  assert.equal(f.sends(), 0);
});

test('real pinned CLI sends one summary to the mock API and repeated day sends nothing', async (t) => {
  const requests = [];
  const apiUrl = await serverFor(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, token: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true,"notification_id":"00000000-0000-0000-0000-000000000001"}');
  });
  const previousWebhook = process.env.PINGROOM_WEBHOOK_URL;
  process.env.PINGROOM_WEBHOOK_URL = `${apiUrl}/wrong-webhook`;
  t.after(() => { if (previousWebhook === undefined) delete process.env.PINGROOM_WEBHOOK_URL; else process.env.PINGROOM_WEBHOOK_URL = previousWebhook; });
  const f = await fixture(t, [event(), event('order-1', 'order')]);
  const local = { ...connection, apiUrl };
  const options = { connection: local, send: (manifest) => sendDigest(manifest, local) };
  assert.equal((await f.run(options)).status, 'sent');
  assert.equal((await f.run(options)).status, 'already-sent');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/agent/rooms/TESTROOM/notifications');
  assert.equal(requests[0].token, 'Bearer test-token');
  assert.match(requests[0].body.message, /2026-01-01 UTC: 1 signups, 1 orders, 0 support tickets/);
  assert.deepEqual(requests[0].body.data.counts, { signup: 1, order: 1, support_ticket: 0 });
  assert.doesNotMatch(JSON.stringify(requests[0].body), /event-1|order-1|test-token/);
  assert.equal((await readJson(f.record('receipt.json'))).notificationId, '00000000-0000-0000-0000-000000000001');
});

test('real CLI error and timeout preserve unknown attempts and cannot trigger an automatic resend', { timeout: 15000 }, async (t) => {
  let hits = 0;
  const apiUrl = await serverFor(t, (_req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"message":"secret diagnostic"}'); }
    // Subsequent request deliberately never responds.
  });
  const f = await fixture(t);
  const local = { ...connection, apiUrl };
  const options = { connection: local, send: (manifest) => sendDigest(manifest, local, { timeoutMs: 5000 }) };
  await assert.rejects(f.run(options), /outcome may be unknown/);
  await assert.rejects(f.run(options), /prior send attempt/);
  assert.equal(hits, 1);
  await assert.rejects(f.run({ ...options, retryUnknown: true,
    send: (manifest) => sendDigest(manifest, local, { timeoutMs: 3000 }),
  }), /outcome may be unknown/);
  assert.equal(hits, 2);
  assert.equal(await readJson(f.record('receipt.json')), null);
});

test('partial environment credentials are rejected before saved credentials are read', async () => {
  await assert.rejects(loadConnection({ PINGROOM_TOKEN: 'test', PINGROOM_HOME: '/never-read' }), /both/);
  await assert.rejects(loadConnection({ PINGROOM_ROOM: 'ROOM', PINGROOM_HOME: '/never-read' }), /both/);
  await assert.rejects(loadConnection({ PINGROOM_TOKEN: '', PINGROOM_ROOM: '', PINGROOM_HOME: '/never-read' }), /both/);
  await assert.rejects(loadConnection({ PINGROOM_TOKEN: ' ', PINGROOM_HOME: '/never-read' }), /both/);
  const manifest = buildManifest(encode([event()]), day, destinationHash(connection));
  assert.ok([...manifest.message].length <= 120);
  assert.doesNotMatch(JSON.stringify(manifest), /test-token/);
});

test('real CLI success without a notification ID remains unknown and does not automatically resend', async (t) => {
  let hits = 0;
  const apiUrl = await serverFor(t, (_req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
  const f = await fixture(t);
  const local = { ...connection, apiUrl };
  const options = { connection: local, send: (manifest) => sendDigest(manifest, local) };
  await assert.rejects(f.run(options), /outcome may be unknown/);
  assert.equal(await readJson(f.record('receipt.json')), null);
  await assert.rejects(f.run(options), /prior send attempt/);
  assert.equal(hits, 1);
});
