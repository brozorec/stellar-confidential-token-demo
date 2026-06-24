import type { Hono } from "hono";

import { getDb } from "../db/client";
import { getPipelineState, queryEvents } from "../db/queries";
import { parseJsonColumn } from "../utils/pipeline";
import type { AppEnv, ErrorResponse, EventsResponse } from "../types";

function jsonError(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

function parseIntParam(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function registerEventsRoute(app: Hono<AppEnv>): void {
  // All events for a contract, ordered oldest→newest. The SDK's hybrid source
  // pages this for the pre-RPC-window backfill and for full-history reads
  // (auditor, recipient discovery, disclosure resolution).
  app.get("/contracts/:contractId/events", async (c) => {
    const contractId = c.req.param("contractId");
    const cursor = c.req.query("cursor");
    let startLedger: number | undefined;
    let endLedger: number | undefined;
    let limit: number | undefined;

    try {
      startLedger = parseIntParam("startLedger", c.req.query("startLedger"));
      endLedger = parseIntParam("endLedger", c.req.query("endLedger"));
      limit = parseIntParam("limit", c.req.query("limit"));
    } catch (error) {
      return c.json(
        jsonError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid query"),
        400,
      );
    }

    const db = getDb(c.env);
    try {
      const [state, { rows, nextCursor }] = await Promise.all([
        getPipelineState(db),
        queryEvents(db, { contractId, startLedger, endLedger, cursor, limit }),
      ]);

      const body: EventsResponse = {
        latestLedger: Number(state?.latest_synced_ledger ?? 0),
        cursor: nextCursor,
        events: rows.map((r) => ({
          id: r.id,
          ledger: Number(r.ledger),
          txHash: r.tx_hash,
          topic: parseJsonColumn(r.topic),
          value: parseJsonColumn(r.value),
        })),
      };
      return c.json(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to query events";
      const status = message.includes("cursor") || message.includes("Invalid") ? 400 : 500;
      return c.json(jsonError(status === 400 ? "INVALID_ARGUMENT" : "INTERNAL", message), status);
    }
  });
}
