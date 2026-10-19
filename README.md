# PingRoom daily digest starter

Turn a closed UTC day of local business events into one PingRoom notification:

```text
2026-01-01 UTC: 12 signups, 8 orders, 3 support tickets.
```

The starter counts fixed event types, seals the input, and records successful
delivery so repeated scheduled runs skip the same day. It uses Node.js 22+ and
the pinned [`@pingroom/cli` 0.13.0](https://github.com/pingroom/cli).

## Try it offline

Create a repository using **Use this template**, or:

```sh
gh repo create YOUR-OWNER/YOUR-REPO --template pingroom/starter-daily-digest --private --clone
cd YOUR-REPO
npm ci
npm run demo
npm test
```

The demo uses temporary files and a simulated sender. It aggregates events,
deduplicates a repeated event, sends one simulated digest, and skips the repeated
day. It reads no credentials and makes no network requests. Tests use local
HTTP servers, including tests of the real installed CLI. CI runs on Node 22 and 24.

## Connect PingRoom

1. [Install or open PingRoom](https://pingroom.io/i) and sign in.
2. Run `npm run connect`. Open its claim link, claim the robot, and choose a home
   room and room access. Keep the pairing process open until it finishes.
3. Copy `.env.example` to `.env` if you need custom input or state directories.

The default connection stays in this starter's ignored `.pingroom/` directory.
Setting `PINGROOM_HOME` in your environment or `.env` explicitly selects another
directory for connection and delivery. Connecting again replaces the credential
in the selected directory.

Alternatively, set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either variable
is provided, both must be nonempty. Blank values also prevent fallback to a saved
connection. Leave both unset to use `npm run connect`. When `CI` is set, both are
required and a saved connection is never read.

Commands load `.env` from the working directory. Existing environment values
take precedence. The starter uses the production PingRoom API and keeps tokens
out of command arguments and logs.

## Export a closed day

Adapt your application's event export to write one local file per UTC day.
Append events to `incoming/YYYY-MM-DD.ndjson.part` while collecting them. After
the day ends, finish any database reads, flush and close the file, then publish
it as `incoming/YYYY-MM-DD.ndjson`. Publish atomically on the same filesystem
and refuse to overwrite an existing final file. Only final `.ndjson` files are
read; `.part` files are ignored.

Each line must contain exactly these three string fields, in any order:

```json
{"id":"signup-1","at":"2026-01-01T08:00:00.000Z","type":"signup"}
{"id":"order-1","at":"2026-01-01T09:30:00.000Z","type":"order"}
{"id":"ticket-1","at":"2026-01-01T12:00:00.000Z","type":"support_ticket"}
```

- `id`: 1–80 ASCII letters, digits, dots, underscores, colons, or hyphens. Use a
  stable ID unique across the day's event types.
- `at`: canonical UTC timestamp with milliseconds and `Z`, inside the named day.
- `type`: exactly `signup`, `order`, or `support_ticket`.

An identical repeated ID is counted once. The same ID with a different timestamp
or type rejects the whole export. Unknown fields/types, duplicate JSON keys,
invalid dates, offset timestamps, blank lines, and incomplete lines also reject
it. Use UTF-8, end nonempty files with a newline, and keep each export within
2 MiB and 10,000 rows, including duplicates. A zero-byte file represents an
explicitly empty day; a missing file does not.

Then run:

```sh
npm start -- --day 2026-01-01
```

Replace the date with your exported day. `npm start` without `--day` selects
yesterday in **UTC**, regardless of your computer's timezone. Today and future
dates are rejected. Counts and the day are sent to PingRoom; individual event
IDs and timestamps stay local. Empty days receive a local receipt without a ping.

## Schedule it

Run the one-shot command with your own scheduler. This hourly cron example picks
up yesterday's export after it becomes available and skips subsequent runs once
the receipt exists. Replace all three paths with your actual paths:

```cron
15 * * * * cd /absolute/path/to/starter-daily-digest && /absolute/path/to/node scripts/digest.mjs >> /absolute/path/to/daily-digest.log 2>&1
```

Find the Node path with `command -v node` and verify Node 22 or newer. Cron uses
the scheduler's timezone for launch times; the digest window is always UTC. An
explicit day covers `[00:00:00.000Z, next-day 00:00:00.000Z)`. Configure your
producer's export window accordingly. No secrets belong in the cron command.
This starter does not install a scheduler.

`INPUT_DIR` defaults to this starter's `incoming/`; `STATE_DIR` defaults to its
`.digest/`. Use absolute paths when customizing them. Keep state on a persistent
local filesystem with hard-link support and use one machine per state directory.
An ephemeral CI runner loses duplicate protection unless you preserve its state.

## Sealed input, receipts, and retries

The first valid run copies the final export to
`.digest/YYYY-MM-DD/input.ndjson` and creates `manifest.json`. The manifest binds
the day, input hash, counts, message, room, and connection fingerprint. No token
is stored in it. **Later changes to the incoming file are ignored after sealing.**
The original incoming file may then be archived; retries use the sealed copy.

A new `attempt-NNNNNN.json` is synced to disk before each send. A confirmed CLI
success must include a valid notification ID before `receipt.json` is written.
Receipt creation is atomic and refuses to replace an existing record. The
starter never rewrites sealed input, manifests, attempts, or receipts.

An error, timeout, interrupted process, or receipt-write failure can leave an
attempt without a success receipt. This is an **unknown outcome**: PingRoom may
already have accepted the notification. Further ordinary runs stop without
sending. Check the room and the day's records, then choose one action:

```sh
# Only after verifying that the digest already arrived:
npm start -- --day 2026-01-01 --confirm-sent

# Explicitly try the identical sealed digest again; a duplicate is possible:
npm start -- --day 2026-01-01 --retry-unknown
```

Confirmation records your decision without sending. Retry appends another
attempt and keeps all previous records. Neither option is accepted when there
is no uncertain attempt. Transport calls stop after 15 seconds. There is no
exactly-once delivery guarantee: the CLI ping command has no server-side
idempotency key, and a crash can occur after acceptance but before the receipt.

For a late event or correction, preserve the old export and records. Issue a
separate, clearly labeled correction through your own reporting process; do not
edit sealed files, delete receipts, or change old timestamps to force a resend.
Changing the room or robot credential for a sealed day is rejected. New days
can use a new connection.

Same-day runs use a local lock. An overlapping run skips; different days have
separate locks. A forced kill or power loss can leave `.digest/YYYY-MM-DD.lock`.
Read its `owner.json`, verify that the owner and any other process using that
day are stopped, then remove only that lock directory. Preserve all day records.
Files accumulate over time: back up receipts and sealed inputs, and plan disk
capacity. Deleting state removes the evidence used to prevent repeated sends.

## Adapt the starter

- [`src/events.mjs`](src/events.mjs): schema, date rules, counts, and message.
- [`src/digest.mjs`](src/digest.mjs): sealing and send receipts.
- [`src/cli.mjs`](src/cli.mjs): bounded CLI delivery with isolated credentials.

Version any changes to the format. Existing manifests must match the current
format; a mismatch blocks the run. Keep summaries within PingRoom's
40-character title and 120-character private-room message limits.

For live service health, see
[starter-uptime-monitor](https://github.com/pingroom/starter-uptime-monitor).
For progress from a running job, see
[starter-job-progress](https://github.com/pingroom/starter-job-progress).

MIT licensed.
