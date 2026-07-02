/**
 * Link to a transaction on stellar.expert (testnet), used everywhere a tx
 * hash is shown. Opens in a new tab so following a tx never loses the app's
 * current state.
 */

import { HoverTip } from "./hover-tip";

function short(hash: string): string {
  return hash ? `${hash.slice(0, 10)}…` : "—";
}

/** 6/4 truncation matching Addr's, for the compact button variant. */
function short6x4(hash: string): string {
  return hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "—";
}

export function TxLink({
  hash,
  full = false,
  variant = "link",
  className = "",
}: {
  hash: string;
  /** Render the untruncated hash instead of the shortened form. */
  full?: boolean;
  /**
   * "link" — inline dotted-underline hash (default).
   * "button" — compact 6/4-truncated hash + arrow, no background, for rows
   * where a boxed pill would be too heavy.
   */
  variant?: "link" | "button";
  className?: string;
}) {
  const href = `https://stellar.expert/explorer/testnet/tx/${hash}`;

  if (variant === "button") {
    return (
      <span className="group relative inline-block">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 font-mono text-xs text-neutral-400 hover:text-neutral-200 ${className}`}
        >
          {short6x4(hash)}
          <span aria-hidden>↗</span>
        </a>
        <HoverTip label="Open on stellar.expert" />
      </span>
    );
  }

  return (
    <span className="group relative inline-block">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`font-mono underline decoration-dotted underline-offset-2 hover:text-neutral-200 ${className}`}
      >
        {full ? hash : short(hash)}
      </a>
      <HoverTip label="Open on stellar.expert" />
    </span>
  );
}
