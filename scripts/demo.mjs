import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigest } from '../src/digest.mjs';

const directory = await mkdtemp(join(tmpdir(), 'digest-demo-'));
const day = '2026-01-01';
const inputDir = join(directory, 'incoming');
const stateDir = join(directory, 'state');
let sent = 0;
try {
  await mkdir(inputDir);
  const events = [
    { id: 'signup-1', at: `${day}T08:00:00.000Z`, type: 'signup' },
    { id: 'order-1', at: `${day}T10:00:00.000Z`, type: 'order' },
    { id: 'order-1', at: `${day}T10:00:00.000Z`, type: 'order' },
    { id: 'ticket-1', at: `${day}T12:00:00.000Z`, type: 'support_ticket' },
  ];
  await writeFile(join(inputDir, `${day}.ndjson`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  console.log('Offline demo: temporary exports and receipts, simulated sender, no credentials or network.');
  const options = { day, inputDir, stateDir, connection: { token: 'demo-only', room: 'DEMO', apiUrl: 'offline' },
    now: () => new Date('2026-01-02T01:00:00.000Z'), send: async (manifest) => { sent++; console.log(`SIMULATED: ${manifest.message}`); } };
  console.log(`First run: ${(await runDigest(options)).status}.`);
  console.log(`Repeated day: ${(await runDigest(options)).status}.`);
  console.log(`Simulated notifications: ${sent}; expected: 1.`);
  if (sent !== 1) throw new Error('Demo duplicate protection failed.');
} finally { await rm(directory, { recursive: true, force: true }); }
