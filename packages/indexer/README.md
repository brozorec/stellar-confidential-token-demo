
# @ctd/indexer

A durable, full-history event source for the confidential-token demo — the complement to the RPC `getEvents` API, which only retains ~7 days of ledgers.

```
Stellar testnet ──► Goldsky turbo pipeline ──► Postgres (raw_events)
                                                   │
                                  Cloudflare Worker (Hono) ──► JSON API
                                                   │
                                          @ctd/sdk hybrid source
```

- **Goldsky pipeline** (`goldsky/pipeline-*.yaml`) mirrors the confidential-token event *family* into a Postgres `raw_events` table. It selects by event **shape**, not by a hardcoded contract id. Each event type is matched by a field signature, not just its symbol, so foreign contracts reusing the same symbols are excluded: `transfer`/`withdraw` require the `sigma` ciphertext field (excludes the SAC/SEP-41 `transfer` firehose, which is also a Map of `{amount, to_muxed_id}`); `deposit` requires the `[from, to]` topic shape plus an `amount` field (excludes vault/budgeting-app deposits); `merge` requires the `[account]` topic plus empty data; `register` requires the `[account]` topic plus an `auditor_id` field. This means every instance is indexed automatically — the demo's own deploy and any contract a user deploys in advanced mode. The Worker also scopes reads to a single `contract_id`, so any unrelated contract that still slips through is never served.
- **Cloudflare Worker** (`handler/`) exposes a thin read API over that table.
- The **SDK** (`@ctd/sdk`) decodes the rows into `ConfidentialEvent`s — the Worker passes the Goldsky `topic`/`value` JSON through untouched so there is a single decoding path, pinned by `packages/sdk/test/indexer-parity.mjs`.

## Deploy

Prerequisites: a Goldsky account + CLI (`goldsky login`), a Postgres instance (e.g. Neon/Supabase), and a Cloudflare account (`wrangler login`).

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

- `GET /health` → `{ latest_synced_ledger }` — how far the pipeline has synced (`MAX(ledger)`, `0` if none yet). The indexer is deliberately behind the chain head (the RPC serves the recent tail), so there is no lag/degraded status.
- `GET /contracts/:contractId/events` → `{ latestLedger, cursor, events: [{ id, ledger, txHash, topic, value }] }`. Query params: `startLedger`, `endLedger` (inclusive ledger bounds), `cursor` (opaque), `limit` (default 200, max 1000). Events are ordered oldest→newest by `id`; follow `cursor` until it is `null`.

## Wiring the app

Point the app at a deployed Worker:

```bash
# packages/app/.env.local
NEXT_PUBLIC_INDEXER_URL=https://confidential-token-indexer.<account>.workers.dev
```

Unset ⇒ the app runs RPC-only (events older than ~7 days are unavailable). The SDK's hybrid source uses the RPC for the recent tail and the indexer only for the portion older than the RPC window.

## Validate decoding

After the pipeline has synced events, pin the SDK decoder against real rows:

```bash
CTD_INDEXER_URL=https://…workers.dev \
CTD_TOKEN=<token contract id> \
pnpm --filter @ctd/sdk exec tsx test/indexer-parity.mjs
```

This compares indexer-decoded events to RPC-decoded events for the same range — they must be byte-identical.

Also pin the Goldsky JSON encoding that the pipeline's **shape filter** depends on (so a Goldsky encoding change fails loudly instead of silently emptying the indexer):

```bash
CTD_INDEXER_URL=https://…workers.dev \
CTD_TOKEN=<token contract id> \
pnpm --filter @ctd/sdk exec tsx test/shape-filter.mjs
```

## Check

```bash
pnpm --filter @ctd/indexer check   # tsc --noEmit
pnpm --filter @ctd/indexer dev      # wrangler dev (needs DATABASE_URL)
```
