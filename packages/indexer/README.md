# @ctd/indexer

A durable, full-history event source for the confidential-token demo — the
complement to the RPC `getEvents` API, which only retains ~7 days of ledgers.

```
Stellar testnet ──► Goldsky turbo pipeline ──► Postgres (raw_events)
                                                   │
                                  Cloudflare Worker (Hono) ──► JSON API
                                                   │
                                          @ctd/sdk hybrid source
```

- **Goldsky pipeline** (`goldsky/pipeline-*.yaml`) mirrors Stellar events whose
  first topic symbol is one of `register | deposit | merge | withdraw | transfer`
  into a Postgres `raw_events` table.
- **Cloudflare Worker** (`handler/`) exposes a thin read API over that table.
- The **SDK** (`@ctd/sdk`) decodes the rows into `ConfidentialEvent`s — the
  Worker passes the Goldsky `topic`/`value` JSON through untouched so there is a
  single decoding path, pinned by `packages/sdk/test/indexer-parity.mjs`.

## Deploy

Prerequisites: a Goldsky account + CLI (`goldsky login`), a Postgres instance
(e.g. Neon/Supabase), and a Cloudflare account (`wrangler login`).

```bash
# 1. Create the table, view, and indexes.
psql "$DATABASE_URL" -f schema.sql

# 2. Register the Postgres credentials Goldsky will sink to.
goldsky secret create INDEXER_POSTGRES_CREDENTIALS \
  --value '{"host":"…","port":5432,"user":"…","password":"…","database":"…","schema":"public"}'

# 3. Apply the pipeline (testnet).
goldsky pipeline apply goldsky/pipeline-testnet.yaml

# 4. Configure and deploy the Worker.
cd packages/indexer
pnpm install
pnpm wrangler secret put DATABASE_URL   # same Postgres as the sink
pnpm wrangler deploy
```

## API

- `GET /health` → `{ latest_synced_ledger }` — how far the pipeline has synced
  (`MAX(ledger)`, `0` if none yet). The indexer is deliberately behind the chain
  head (the RPC serves the recent tail), so there is no lag/degraded status.
- `GET /contracts/:contractId/events` → `{ latestLedger, cursor, events: [{ id, ledger, txHash, topic, value }] }`.
  Query params: `startLedger`, `endLedger` (inclusive ledger bounds), `cursor`
  (opaque), `limit` (default 200, max 1000). Events are ordered oldest→newest by
  `id`; follow `cursor` until it is `null`.

## Wiring the app

Point the app at a deployed Worker:

```bash
# packages/app/.env.local
NEXT_PUBLIC_INDEXER_URL=https://confidential-token-indexer.<account>.workers.dev
```

Unset ⇒ the app runs RPC-only (events older than ~7 days are unavailable). The
SDK's hybrid source uses the RPC for the recent tail and the indexer only for
the portion older than the RPC window.

## Validate decoding

After the pipeline has synced events, pin the SDK decoder against real rows:

```bash
CTD_INDEXER_URL=https://…workers.dev \
CTD_TOKEN=<token contract id> \
pnpm --filter @ctd/sdk exec tsx test/indexer-parity.mjs
```

This compares indexer-decoded events to RPC-decoded events for the same range —
they must be byte-identical.

## Check

```bash
pnpm --filter @ctd/indexer check   # tsc --noEmit
pnpm --filter @ctd/indexer dev      # wrangler dev (needs DATABASE_URL)
```
