/** Shared "0xabc…wxyz"-style truncation for addresses, contract ids, and tx hashes. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  return value ? `${value.slice(0, head)}…${value.slice(-tail)}` : "—";
}

/** Prefix-only truncation ("0xabc…"), used for tx hashes in log lines and links. */
export function truncatePrefix(value: string, head = 10): string {
  return value ? `${value.slice(0, head)}…` : "—";
}

/**
 * XLM ⇄ stroops. The contract (and every SDK amount) is denominated in stroops,
 * the asset's smallest unit; the UI presents whole XLM. 1 XLM = 10^7 stroops,
 * the native Stellar precision. This assumes the underlying asset has 7 decimals
 * (true for the XLM SAC) — a custom underlying with different precision would be
 * mis-scaled.
 */
export const STROOPS_PER_XLM = 10_000_000n;
const XLM_DECIMALS = 7;

/**
 * Parse a human XLM amount (decimal string) into on-chain stroops. Throws on
 * malformed input or more than 7 fractional digits (finer than a stroop).
 */
export function xlmToStroops(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid XLM amount: "${input}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > XLM_DECIMALS) {
    throw new Error(`too many decimals — max ${XLM_DECIMALS} for XLM: "${input}"`);
  }
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(XLM_DECIMALS, "0"));
}

/**
 * Format on-chain stroops as a human XLM string, trimming trailing zeros.
 * `1234500000n` → "123.45", `10000000n` → "1", `0n` → "0".
 */
export function stroopsToXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = abs % STROOPS_PER_XLM;
  const sign = neg ? "-" : "";
  if (frac === 0n) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(XLM_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}
