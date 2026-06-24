import type { Hono } from "hono";

import { getDb } from "../db/client";
import { getPipelineState } from "../db/queries";
import type { AppEnv, HealthResponse } from "../types";

export function registerHealthRoute(app: Hono<AppEnv>): void {
  // Reports only how far the pipeline has synced (MAX(ledger)). The indexer is
  // deliberately the behind-the-tip source — the RPC serves the recent tail —
  // so there is no "lag/degraded" status to report; consumers compare this
  // watermark against their own needs.
  app.get("/health", async (c) => {
    const state = await getPipelineState(getDb(c.env));
    const body: HealthResponse = {
      latest_synced_ledger: Number(state?.latest_synced_ledger ?? 0),
    };
    return c.json(body);
  });
}
