/**
 * Detects that the built-in default token has been redeployed and evicts the
 * localStorage left behind by the previous one.
 *
 * Why this is needed: confidential keys are contract-bound (`vk` binds the
 * token's `addr_f`), so a redeployed default token cannot reuse the cached
 * `ctd:sk:<oldToken>:<account>` secret or the `ctd:state:<oldToken>:` opening
 * cache — the account simply does not exist on the new contract. Left in place
 * those entries are dead weight, and their presence makes it look as though the
 * user still holds a balance they can no longer touch. Sweeping them is
 * lossless: `sk` is derived deterministically from a Freighter signature over a
 * message that includes the token id (see wallet.ts `connect`), so reconnecting
 * to any token re-derives its key.
 *
 * Precision comes from the `ctd:default:token` marker, which records the default
 * token this browser last saw. A marker that disagrees with the compiled-in
 * default is proof of a redeploy, and only keys under the *recorded* token are
 * touched. Installs predating the marker fall back to a one-time sweep of
 * orphans — see `sweepStaleDefaultKeys`.
 */

const MARKER_KEY = "ctd:default:token";
const SK_PREFIX = "ctd:sk:";
const STATE_PREFIX = "ctd:state:";

export interface StaleSweep {
  /** Token ids whose cached keys/state were removed. */
  tokens: string[];
  /**
   * How confidently the eviction is attributable to the default token being
   * redeployed — it decides which notice the wallet page shows.
   *
   * "redeployed" — certain. Either the marker disagreed with the current default
   * token, or there is no advanced deployment saved, leaving a previous default
   * as the only thing the swept keys could have come from.
   * "orphaned" — ambiguous. No marker, but an advanced deployment exists, so the
   * keys may instead belong to an advanced token that was since overwritten.
   */
  reason: "redeployed" | "orphaned";
}

/** Every `ctd:sk:<token>:<account>` token segment currently in localStorage. */
function cachedKeyTokens(): string[] {
  const tokens = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(SK_PREFIX)) continue;
    // ctd:sk:<token>:<account> — take the token segment.
    const token = key.slice(SK_PREFIX.length).split(":")[0];
    if (token) tokens.add(token);
  }
  return [...tokens];
}

/** Drop the cached spending key and opening cache for one token. */
function evictToken(token: string): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(`${SK_PREFIX}${token}:`) || key.startsWith(`${STATE_PREFIX}${token}:`)) {
      doomed.push(key);
    }
  }
  // Collected first: removing during iteration shifts localStorage's indices.
  for (const key of doomed) localStorage.removeItem(key);
}

/**
 * Run once per app load, after the persisted advanced deployment is known.
 * Returns what was swept (for the user-facing notice), or null when there was
 * nothing to do — the overwhelmingly common case.
 *
 * `advancedToken` is spared: the advanced slot is a separate, still-live
 * deployment. A *previous* advanced token can be caught by the "orphaned"
 * branch, which is why that branch only runs when this browser has no marker
 * yet; every later redeploy takes the precise "redeployed" path.
 */
export function sweepStaleDefaultKeys(
  defaultToken: string,
  advancedToken: string | null,
): StaleSweep | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const marker = localStorage.getItem(MARKER_KEY);
    localStorage.setItem(MARKER_KEY, defaultToken);

    if (marker === defaultToken) return null;

    if (marker) {
      // Definite redeploy: evict exactly the token we recorded as the default.
      if (marker === advancedToken) return null;
      const had = cachedKeyTokens().includes(marker);
      evictToken(marker);
      return had ? { tokens: [marker], reason: "redeployed" } : null;
    }

    // No marker: an install from before it existed. Sweep keys belonging to no
    // deployment the app serves today. With no advanced slot in play the only
    // token this browser can have held keys for is an earlier default, so the
    // redeploy notice is safe to state outright.
    const live = new Set([defaultToken, ...(advancedToken ? [advancedToken] : [])]);
    const stale = cachedKeyTokens().filter((t) => !live.has(t));
    for (const token of stale) evictToken(token);
    if (stale.length === 0) return null;
    return { tokens: stale, reason: advancedToken ? "orphaned" : "redeployed" };
  } catch {
    // localStorage unavailable (private mode, quota). Non-fatal: the stale
    // entries are inert, and the wallet keys off the current token regardless.
    return null;
  }
}
