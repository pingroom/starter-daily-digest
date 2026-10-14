import { randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readBounded(path, limit) {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Input or state file exceeds its size limit or is not a regular file.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('Input or state file grew beyond its size limit.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Input changed while being read. Publish a closed export before running the digest.');
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

export async function readJson(path) {
  try { return JSON.parse((await readBounded(path, 65536)).toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('A state record could not be read. Preserve it and restore from a trusted backup.');
  }
}

async function syncDirectory(path) {
  let directory;
  try { directory = await open(path, 'r'); await directory.sync(); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error;
  } finally { await directory?.close(); }
}

export async function writeNew(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;
    // Linking atomically publishes the file and refuses to overwrite a record.
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export const writeJsonNew = (path, value) => writeNew(path, `${JSON.stringify(value, null, 2)}\n`);
