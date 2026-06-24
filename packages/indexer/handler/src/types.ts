export interface EnvBindings {
  /** Postgres connection string the Goldsky sink writes to. */
  DATABASE_URL: string;
  INDEXER_NETWORK?: string;
  CORS_ORIGIN?: string;
}

export interface AppEnv {
  Bindings: EnvBindings;
}

export interface PipelineStateRow {
  latest_synced_ledger: number | null;
  updated_at: string | Date;
}

/** A raw event row, returned to clients as a thin pass-through (SDK decodes). */
export interface RawEventRow {
  id: string;
  ledger: number;
  tx_hash: string | null;
  /** Goldsky JSON of the ScVal topics array (TEXT in Postgres). */
  topic: string;
  /** Goldsky JSON of the event data ScVal map (TEXT in Postgres). */
  value: string;
}

/** One event in an /events response — topic/value parsed to JSON for the client. */
export interface EventResponse {
  id: string;
  ledger: number;
  txHash: string | null;
  topic: unknown;
  value: unknown;
}

export interface EventsResponse {
  latestLedger: number;
  cursor: string | null;
  events: EventResponse[];
}

export interface HealthResponse {
  /** Highest ledger the pipeline has synced (MAX(ledger)); 0 if none yet. */
  latest_synced_ledger: number;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
