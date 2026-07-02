/** Shared "0xabc…wxyz"-style truncation for addresses, contract ids, and tx hashes. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  return value ? `${value.slice(0, head)}…${value.slice(-tail)}` : "—";
}

/** Prefix-only truncation ("0xabc…"), used for tx hashes in log lines and links. */
export function truncatePrefix(value: string, head = 10): string {
  return value ? `${value.slice(0, head)}…` : "—";
}
