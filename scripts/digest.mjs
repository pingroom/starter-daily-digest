import { loadConnection, loadEnvironment, paths } from '../src/config.mjs';
import { sendDigest } from '../src/cli.mjs';
import { runDigest } from '../src/digest.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  loadEnvironment();
  const flags = process.argv.slice(2);
  let day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let retryUnknown = false;
  let confirmSent = false;
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw new Error('Do not repeat command options.');
    seen.add(flag);
    if (flag === '--day' && flags[index + 1]) day = flags[++index];
    else if (flag === '--retry-unknown') retryUnknown = true;
    else if (flag === '--confirm-sent') confirmSent = true;
    else throw new Error('Usage: npm start -- [--day YYYY-MM-DD] [--retry-unknown | --confirm-sent]');
  }
  const connection = await loadConnection();
  const result = await runDigest({ day, ...paths(), connection, retryUnknown, confirmSent, signal: controller.signal,
    send: (manifest) => sendDigest(manifest, connection, { signal: controller.signal }) });
  console.log(`${day}: ${result.status}; notifications sent by this run: ${result.sent}.`);
  if (result.manifest) console.log(result.manifest.message);
} catch (error) {
  console.error(controller.signal.aborted ? 'Digest interrupted. Check the day record before retrying.' : error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
