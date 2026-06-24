import postgres, { type Sql } from "postgres";

import type { EnvBindings } from "../types";

export function getDb(env: EnvBindings): Sql {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  // One connection per request — Cloudflare Workers pool/recycle internally.
  return postgres(env.DATABASE_URL, { max: 1, prepare: false });
}
