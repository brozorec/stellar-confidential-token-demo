/**
 * Render an unknown thrown value as a human-readable string.
 *
 * Not everything thrown is an `Error`. The Stellar SDK's JSON-RPC client throws
 * the raw JSON-RPC error object (`throw response.data.error`), i.e. a plain
 * `{ code, message }` — `String(e)` on that yields the useless "[object
 * Object]". This unwraps the common shapes (Error, `{ message }`,
 * `{ code, message }`) so RPC failures surface their actual message.
 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown };
    if (typeof o.message === "string") {
      return o.code !== undefined ? `${o.message} (code ${String(o.code)})` : o.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through to String() */
    }
  }
  return String(e);
}
