-- Postgres schema for the confidential-token indexer.
--
-- The Goldsky sink upserts one row per matching contract event into raw_events.
-- The pipeline filters by event SHAPE, not by a hardcoded contract id (see
-- goldsky/pipeline-testnet.yaml): it captures the confidential-token event
-- family emitted by ANY contract, matched by event shape: `transfer`/`withdraw`
-- by the `sigma` ciphertext field (so the SAC / SEP-41 transfer firehose, also a
-- Map of {amount, to_muxed_id}, is excluded); `deposit` by the [from, to] topic
-- shape plus an `amount` field; `merge` by the [account] topic plus empty data;
-- `register` by the [account] topic plus an `auditor_id` field. That is
-- deliberate: every instance is indexed
-- automatically, including ones a user
-- deploys in advanced mode without write access to this database. The Worker
-- then scopes reads to a single contract_id, so this table may hold a few
-- unrelated contracts' events but the read API never serves them. `topic` /
-- `value` are the Goldsky JSON of the ScVal topics array and the event data map
-- — the Worker passes them through untouched and the SDK decodes them (parity
-- with the RPC XDR decoder). The generated columns below are read-side helpers.

CREATE TABLE IF NOT EXISTS raw_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  ledger INTEGER NOT NULL,
  ledger_closed_at TIMESTAMPTZ,
  tx_hash TEXT,
  transaction_index INTEGER,
  operation_index INTEGER,
  topic TEXT NOT NULL,           -- JSON array of event topics
  value TEXT NOT NULL,           -- JSON-serialized event data (ScVal map)
  event_name TEXT GENERATED ALWAYS AS (
    COALESCE(topic::jsonb -> 0 ->> 'symbol', topic::jsonb ->> 0)
  ) STORED,
  -- Participant addresses, by event shape (see contract events: register/
  -- deposit/merge/withdraw/transfer; no operator events in this demo).
  from_topic TEXT GENERATED ALWAYS AS (
    CASE WHEN COALESCE(topic::jsonb -> 0 ->> 'symbol', topic::jsonb ->> 0)
              IN ('deposit', 'transfer', 'withdraw')
         THEN COALESCE(topic::jsonb -> 1 ->> 'address', topic::jsonb ->> 1) END
  ) STORED,
  to_topic TEXT GENERATED ALWAYS AS (
    CASE WHEN COALESCE(topic::jsonb -> 0 ->> 'symbol', topic::jsonb ->> 0)
              IN ('deposit', 'transfer', 'withdraw')
         THEN COALESCE(topic::jsonb -> 2 ->> 'address', topic::jsonb ->> 2) END
  ) STORED,
  account_topic TEXT GENERATED ALWAYS AS (
    CASE WHEN COALESCE(topic::jsonb -> 0 ->> 'symbol', topic::jsonb ->> 0)
              IN ('register', 'merge')
         THEN COALESCE(topic::jsonb -> 1 ->> 'address', topic::jsonb ->> 1) END
  ) STORED
);

-- Reported by /health and as `latestLedger` on event responses. MAX(ledger) is
-- a conservative watermark of how far the pipeline has synced.
CREATE OR REPLACE VIEW pipeline_state AS
SELECT
  'confidential-token-testnet' AS pipeline_name,
  MAX(ledger)                  AS latest_synced_ledger,
  NOW()                        AS updated_at
FROM raw_events;

-- Primary read path: events for a contract in id (≈ ledger) order.
CREATE INDEX IF NOT EXISTS idx_events_contract_ledger
  ON raw_events (contract_id, ledger, id);
-- Optional address-scoped helpers (single-account queries).
CREATE INDEX IF NOT EXISTS idx_events_to
  ON raw_events (contract_id, to_topic, ledger, id);
CREATE INDEX IF NOT EXISTS idx_events_from
  ON raw_events (contract_id, from_topic, ledger, id);
CREATE INDEX IF NOT EXISTS idx_events_account
  ON raw_events (contract_id, account_topic, ledger, id);
