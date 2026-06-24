import type { Sql } from "postgres";

import type { PipelineStateRow, RawEventRow } from "../types";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function clampLimit(limit?: number | null): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/** Opaque pagination cursor: base64 of the last row id. */
export function encodeCursor(lastId: string): string {
  return btoa(lastId);
}

function decodeCursor(cursor: string): string {
  try {
    return atob(cursor);
  } catch {
    throw new Error("Invalid cursor");
  }
}

export async function getPipelineState(db: Sql): Promise<PipelineStateRow | null> {
  const rows = await db<PipelineStateRow[]>`
    SELECT latest_synced_ledger, updated_at FROM pipeline_state LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * All events for a contract, ordered by id ascending, paginated by the opaque
 * cursor (`id > lastId`). `startLedger`/`endLedger` are inclusive ledger bounds.
 * Fetches `limit + 1` to detect a further page.
 *
 * Assumes the Goldsky `id` is the canonical, fixed-width Stellar event id, so
 * lexicographic `id` order == chain order and cursor paging never skips or
 * duplicates rows. (The SDK additionally stable-sorts merged results by ledger,
 * so cross-source ordering is robust even if intra-ledger id order varies.)
 */
export async function queryEvents(
  db: Sql,
  input: {
    contractId: string;
    startLedger?: number | null;
    endLedger?: number | null;
    cursor?: string | null;
    limit?: number | null;
  },
): Promise<{ rows: RawEventRow[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const values: Array<string | number> = [input.contractId];
  let query = `
    SELECT id, ledger, tx_hash, topic, value
    FROM raw_events
    WHERE contract_id = $1
  `;

  if (input.cursor) {
    values.push(decodeCursor(input.cursor));
    query += ` AND id > $${values.length}`;
  }
  if (typeof input.startLedger === "number") {
    values.push(input.startLedger);
    query += ` AND ledger >= $${values.length}`;
  }
  if (typeof input.endLedger === "number") {
    values.push(input.endLedger);
    query += ` AND ledger <= $${values.length}`;
  }

  values.push(limit + 1);
  query += ` ORDER BY id ASC LIMIT $${values.length}`;

  const rows = await db.unsafe<RawEventRow[]>(query, values);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}
