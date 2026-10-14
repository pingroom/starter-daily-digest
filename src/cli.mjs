import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');

export async function sendDigest(manifest, connection, { signal, timeoutMs = 15000 } = {}) {
  if ([...manifest.title].length > 40 || [...manifest.message].length > 120) throw new Error('Digest exceeds PingRoom title or private-room message limits.');
  const home = await mkdtemp(join(tmpdir(), 'pingroom-digest-'));
  try {
    const { stdout } = await exec(process.execPath, [cliPath, 'ping', '--json', '--title', manifest.title,
      '--message', manifest.message, '--data', JSON.stringify({ digest_id: manifest.digestId, day: manifest.day, counts: manifest.summary.counts }),
    ], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1',
        PINGROOM_HOME: home, PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: connection.room, PINGROOM_API_URL: connection.apiUrl },
      signal, timeout: timeoutMs, maxBuffer: 65536,
    });
    const response = JSON.parse(stdout);
    const id = response?.notification_id ?? response?.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
      || (response.notification_id !== undefined && response.id !== undefined && response.notification_id !== response.id)) {
      throw new Error('API success did not include an unambiguous notification ID.');
    }
    return { notificationId: id };
  } catch {
    throw new Error('CLI delivery did not produce a confirmed success. The remote outcome may be unknown.');
  } finally { await rm(home, { recursive: true, force: true }); }
}
