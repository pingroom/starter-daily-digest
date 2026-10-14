import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const connectionHome = (env = process.env) => env.PINGROOM_HOME || join(projectRoot, '.pingroom');

export function loadEnvironment() {
  try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.'); }
}

export function paths(env = process.env) {
  return {
    inputDir: env.INPUT_DIR ? resolve(env.INPUT_DIR) : join(projectRoot, 'incoming'),
    stateDir: env.STATE_DIR ? resolve(env.STATE_DIR) : join(projectRoot, '.digest'),
  };
}

export async function loadConnection(env = process.env) {
  const token = env.PINGROOM_TOKEN?.trim();
  const room = env.PINGROOM_ROOM?.trim();
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined || env.CI) {
    if (!token || !room) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; environment and saved credentials cannot be mixed.');
    return { token, room, apiUrl: 'https://api.pingroom.io' };
  }
  let saved;
  try { saved = JSON.parse(await readFile(join(connectionHome(env), 'credentials.json'), 'utf8')); }
  catch { throw new Error('No readable starter connection. Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  if (typeof saved.token !== 'string' || !saved.token || typeof saved.room?.invite_code !== 'string' || !saved.room.invite_code) {
    throw new Error('The saved connection needs a token and home room. Run npm run connect and choose a room.');
  }
  let origin;
  try { origin = new URL(saved.api_url || 'https://api.pingroom.io').origin; } catch { throw new Error('Saved API origin is invalid.'); }
  if (origin !== 'https://api.pingroom.io') throw new Error('This starter requires a production PingRoom connection.');
  return { token: saved.token, room: saved.room.invite_code, apiUrl: origin };
}

export function destinationHash(connection) {
  return hash(JSON.stringify({ apiUrl: connection.apiUrl, room: connection.room, tokenHash: hash(connection.token) }));
}
