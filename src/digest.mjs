import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildManifest, closedDay, MAX_BYTES } from './events.mjs';
import { destinationHash } from './config.mjs';
import { readBounded, readJson, writeJsonNew, writeNew } from './storage.mjs';

export async function runDigest({ day, inputDir, stateDir, connection, send, retryUnknown = false, confirmSent = false, signal, now = () => new Date() }) {
  closedDay(day, now());
  if (retryUnknown && confirmSent) throw new Error('Choose either --retry-unknown or --confirm-sent.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, `${day}.lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') return { status: 'locked', sent: 0 };
    throw error;
  }
  try {
    await writeJsonNew(join(lock, 'owner.json'), { pid: process.pid, startedAt: now().toISOString() });
    signal?.throwIfAborted();
    const directory = join(stateDir, day);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sealedPath = join(directory, 'input.ndjson');
    let bytes;
    try { bytes = await readBounded(sealedPath, MAX_BYTES); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { bytes = await readBounded(join(inputDir, `${day}.ndjson`), MAX_BYTES); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error(`No closed export for ${day}; publish incoming/${day}.ndjson first.`);
        throw error;
      }
      buildManifest(bytes, day, destinationHash(connection));
      await writeNew(sealedPath, bytes);
    }
    const expected = buildManifest(bytes, day, destinationHash(connection));
    const manifestPath = join(directory, 'manifest.json');
    let manifest = await readJson(manifestPath);
    if (!manifest) { await writeJsonNew(manifestPath, expected); manifest = expected; }
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
      throw new Error('Sealed input, connection, or digest format differs from the manifest. Preserve the records; this day cannot be silently rewritten.');
    }
    const receiptPath = join(directory, 'receipt.json');
    const receipt = await readJson(receiptPath);
    if (receipt) {
      if (receipt.version !== 1 || receipt.digestId !== manifest.digestId || !['sent', 'empty'].includes(receipt.status)) {
        throw new Error('The day receipt is invalid. Preserve it and restore from a trusted backup.');
      }
      return { status: `already-${receipt.status}`, sent: 0, manifest };
    }
    const names = await readdir(directory);
    const attempts = names.filter((name) => /^attempt-\d{6}\.json$/.test(name));
    if (attempts.length && !retryUnknown && !confirmSent) {
      throw new Error('A prior send attempt has no success receipt. Check PingRoom, then use --confirm-sent or explicitly --retry-unknown (may duplicate).');
    }
    if (!attempts.length && (retryUnknown || confirmSent)) throw new Error('There is no uncertain send attempt to resolve.');
    if (!manifest.summary.total || confirmSent) {
      const status = confirmSent ? 'sent' : 'empty';
      await writeJsonNew(receiptPath, { version: 1, digestId: manifest.digestId, status,
        confirmedByOperator: confirmSent, recordedAt: now().toISOString() });
      return { status, sent: 0, manifest };
    }
    const attempt = Math.max(0, ...attempts.map((name) => Number(name.slice(8, 14)))) + 1;
    if (attempt > 999999) throw new Error('Send attempt limit reached.');
    signal?.throwIfAborted();
    await writeJsonNew(join(directory, `attempt-${String(attempt).padStart(6, '0')}.json`), {
      version: 1, digestId: manifest.digestId, attempt, status: 'sending', startedAt: now().toISOString(),
    });
    try {
      const result = await send(manifest);
      await writeJsonNew(receiptPath, { version: 1, digestId: manifest.digestId, status: 'sent', attempt,
        notificationId: result?.notificationId ?? null, recordedAt: now().toISOString() });
      return { status: 'sent', sent: 1, manifest };
    } catch {
      throw new Error('Delivery or receipt persistence failed; outcome may be unknown. No automatic resend. Check PingRoom before resolving this attempt.');
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
