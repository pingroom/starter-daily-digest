import { hash } from './config.mjs';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_EVENTS = 10000;
const kinds = ['signup', 'order', 'support_ticket'];
const jsonString = String.raw`"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"`;
const field = String.raw`"(?:id|at|type)"\s*:\s*${jsonString}`;
const rowShape = new RegExp(String.raw`^\s*\{\s*${field}\s*,\s*${field}\s*,\s*${field}\s*\}\s*$`);

export function closedDay(day, now = new Date()) {
  let start;
  try { start = new Date(`${day}T00:00:00.000Z`); } catch {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !Number.isFinite(start?.getTime()) || start.toISOString().slice(0, 10) !== day) {
    throw new Error('Use a real UTC calendar date in YYYY-MM-DD format.');
  }
  const end = start.getTime() + 86400000;
  if (end > now.getTime()) throw new Error('The requested UTC day has not closed yet.');
  return day;
}

export function aggregate(bytes, day) {
  if (bytes.length > MAX_BYTES) throw new Error('Input exceeds the 2 MiB limit.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Input must be valid UTF-8.'); }
  if (text && !text.endsWith('\n')) throw new Error('Input must end with a newline; an unfinished export must stay .part.');
  const rows = text ? text.slice(0, -1).split('\n') : [];
  if (rows.length > MAX_EVENTS) throw new Error('Input exceeds the 10,000-row limit.');
  const counts = { signup: 0, order: 0, support_ticket: 0 };
  const seen = new Map();
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const invalid = () => new Error(`Invalid event at line ${index + 1}; use exactly id, at, and type string fields.`);
    if (!rowShape.test(row)) throw invalid();
    const event = JSON.parse(row);
    if (Object.keys(event).length !== 3 || typeof event.id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(event.id)
      || !kinds.includes(event.type) || typeof event.at !== 'string') throw invalid();
    let instant;
    try { instant = new Date(event.at).toISOString(); } catch { throw invalid(); }
    if (instant !== event.at || event.at.slice(0, 10) !== day) throw new Error(`Event at line ${index + 1} must use a canonical UTC timestamp inside ${day}.`);
    const fingerprint = `${event.at}/${event.type}`;
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== fingerprint) throw new Error(`Conflicting duplicate event ID at line ${index + 1}.`);
      duplicates++;
      continue;
    }
    seen.set(event.id, fingerprint);
    counts[event.type]++;
  }
  return { counts, total: seen.size, sourceRows: rows.length, duplicates };
}

export function buildManifest(bytes, day, destination) {
  const summary = aggregate(bytes, day);
  const inputHash = hash(bytes);
  const digestId = hash(JSON.stringify({ version: 1, day, inputHash, destination }));
  return {
    version: 1, day, inputHash, destination, digestId, summary, title: 'Daily digest',
    message: `${day} UTC: ${summary.counts.signup} signups, ${summary.counts.order} orders, ${summary.counts.support_ticket} support tickets.`,
  };
}
