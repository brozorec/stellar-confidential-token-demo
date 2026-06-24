/**
 * Hybrid event source: RPC for the recent tail, the Goldsky indexer for the
 * portion older than the RPC's ~7-day retention window.
 *
 * Strategy ("RPC tip + indexer backfill"):
 *   next = cursor ? cursorLedger(cursor)+1 : fromLedger
 *   if indexer configured AND next < rpcOldest:
 *     - indexer covers [next, rpcOldest-1]   (only it has these)
 *     - RPC covers      [rpcOldest, head]    (clean ledger boundary)
 *   else:
 *     - RPC only, from the stored cursor (warm) or clamp(fromLedger, rpcOldest)
 *
 * Because the indexer leg ends at `rpcOldest-1` and the RPC leg starts at
 * `rpcOldest`, the two ranges are disjoint by construction — correctness does
 * NOT depend on cross-source id equality. {@link dedupeById} is only a
 * belt-and-suspenders guard for the boundary ledger (and because
 * `StateEngine.apply` is not idempotent, a stray duplicate would double-count).
 *
 * The indexer is OPTIONAL: when `indexer` is `undefined` or a call throws, this
 * degrades to today's RPC-only behavior (pre-window history simply unavailable).
 */

import {
  cursorLedger,
  fetchEvents,
  resolveEventRef,
  type ConfidentialEvent,
  type EventRef,
  type FetchEventsResult,
} from "./events.js";
import type { ChainClient } from "./client.js";
import type { IndexerClient } from "./indexer.js";

/**
 * Number of ledgers of headroom above the RPC's reported `oldestLedger` at
 * which the RPC leg starts. The RPC rejects a `startLedger` below its live
 * retention floor, and that floor advances as ledgers are garbage-collected
 * between reading `getHealth()` and issuing `getEvents` (the indexer backfill
 * runs in between). The indexer covers everything below this seam, so the
 * margin loses no events — it only keeps the RPC call safely inside the window.
 */
const RPC_SEAM_MARGIN = 60;

/**
 * Deduplicate events by their canonical id (`cursor`), preserving input order
 * within a ledger and sorting only by ledger. The caller passes events already
 * in apply order ([indexer-old, …rpc-recent], disjoint ledger ranges), so a
 * STABLE sort by ledger keeps each source's intra-ledger order intact — we do
 * NOT re-sort by id string, which would misorder same-ledger events if the
 * indexer's ids aren't zero-padded. `StateEngine.apply` is order-sensitive
 * (a merge after a deposit in one ledger), so this ordering is load-bearing.
 */
export function dedupeById(events: ConfidentialEvent[]): ConfidentialEvent[] {
  const byId = new Map<string, ConfidentialEvent>();
  for (const ev of events) if (!byId.has(ev.cursor)) byId.set(ev.cursor, ev);
  // Array.prototype.sort is stable (ES2019+), so equal-ledger events keep their
  // Map insertion order, which is the correctly-ordered source order.
  return [...byId.values()].sort((a, b) => a.ledger - b.ledger);
}

async function rpcOldestLedger(client: ChainClient): Promise<number> {
  try {
    const health = await client.server.getHealth();
    return health.oldestLedger ?? 0;
  } catch {
    return 0; // health endpoint variations are non-fatal
  }
}

/**
 * Fetch events covering `[next, head]`, splitting across the indexer (old) and
 * the RPC (recent) per the strategy above. Returns the same shape as
 * {@link fetchEvents}; `cursor` is always the RPC resume cursor (the only one
 * the StateEngine persists).
 */
export async function hybridFetchEvents(
  client: ChainClient,
  indexer: IndexerClient | undefined,
  opts: { fromLedger: number; startCursor?: string },
): Promise<FetchEventsResult> {
  const tokenId = client.cfg.contracts.token;
  // `next` is the first ledger we still need. Using cursorLedger+1 assumes the
  // previous sync consumed the cursor's ledger in full — true here because
  // fetchEvents pages all the way to the chain head, so a stored cursor only
  // ever sits at a ledger boundary unless a single ledger emits more than
  // pageLimit (100) token events, which this demo never produces.
  const next = opts.startCursor ? cursorLedger(opts.startCursor) + 1 : opts.fromLedger;

  // The retention floor is only needed to decide the indexer seam or to clamp a
  // cold start; a warm RPC-only resume (cursor, no indexer) doesn't need it, so
  // skip the getHealth round-trip there — that is the steady-state path.
  const rpcOldest = indexer || !opts.startCursor ? await rpcOldestLedger(client) : 0;

  let old: ConfidentialEvent[] = [];
  let recent: FetchEventsResult;

  if (indexer && rpcOldest > 0 && next < rpcOldest) {
    // Backfill the pre-window portion from the indexer, then take the RPC tail
    // from a seam a margin above the live retention floor (so the RPC call
    // can't reject a startLedger that aged out during the backfill). The seam
    // is a clean ledger boundary: indexer owns [next, seam-1], RPC owns
    // [seam, head], disjoint by construction. The stale cursor (if any) is
    // discarded — it points before the window and the RPC would reject it.
    const seam = rpcOldest + RPC_SEAM_MARGIN;
    try {
      const res = await indexer.fetchEvents({
        contractId: tokenId,
        startLedger: next,
        endLedger: seam - 1,
      });
      old = res.events;
    } catch (e) {
      console.warn(
        `[ctd] indexer backfill failed (${String((e as Error)?.message ?? e)}); ` +
          `pre-window history before ledger ${seam} is unavailable this sync`,
      );
    }
    recent = await fetchEvents(client, { startLedger: seam });
  } else if (opts.startCursor) {
    // Warm path: resume RPC from the stored cursor. Indexer untouched.
    recent = await fetchEvents(client, { startCursor: opts.startCursor });
  } else {
    // Cold start within (or no) window: RPC only, clamped just inside the
    // retention floor so getEvents can't reject an aged-out startLedger.
    const floor = rpcOldest > 0 ? rpcOldest + 1 : opts.fromLedger;
    recent = await fetchEvents(client, { startLedger: Math.max(opts.fromLedger, floor) });
  }

  return {
    events: dedupeById([...old, ...recent.events]),
    cursor: recent.cursor,
    latestLedger: recent.latestLedger,
  };
}

/**
 * Resolve a pinned event, trying the RPC first and falling back to the indexer.
 *
 * The common case — verifying a freshly-created disclosure — pins a recent event
 * the RPC serves in one call, and the RPC is the fresher, authoritative source
 * (the indexer lags the chain head). Only when the RPC yields nothing — because
 * the event aged out of the ~7-day window, which surfaces as either a thrown
 * out-of-range error or an empty result — do we fall back to the indexer's
 * durable full history. Both sources resolve to the same event (ids are
 * normalized via `naturalEventId`), so the order is a pure latency choice that
 * favors the hot path.
 */
export async function hybridResolveEventRef(
  client: ChainClient,
  indexer: IndexerClient | undefined,
  ref: EventRef,
): Promise<ConfidentialEvent | null> {
  const fromRpc = await resolveEventRef(client, ref).catch(() => null);
  if (fromRpc || !indexer) return fromRpc;
  return indexer.resolveEventRef(client.cfg.contracts.token, ref).catch(() => null);
}
