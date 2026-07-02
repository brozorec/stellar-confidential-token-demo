"use client";

/**
 * Click-to-copy address display, used everywhere a G-/C-address is shown.
 * Clicking the text itself copies the full value to the clipboard and briefly
 * swaps in "Copied" feedback — there is no separate copy icon/button, so every
 * address in the app shares one interaction (click the text) and one
 * truncation width (6/4).
 */

import { useState, type MouseEvent } from "react";
import { HoverTip } from "./hover-tip";

function short(value: string): string {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
}

export function Addr({
  value,
  full = false,
  className = "",
}: {
  value: string;
  /** Render the untruncated value instead of the shortened form. */
  full?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <span className="group relative inline-block">
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy address ${value}`}
        className={`inline cursor-pointer appearance-none border-0 bg-transparent p-0 font-mono decoration-dotted underline-offset-2 hover:underline focus-visible:underline ${
          copied ? "text-emerald-400" : ""
        } ${className}`}
      >
        {copied ? "Copied ✓" : full ? value : short(value)}
      </button>
      {!copied && <HoverTip label="Copy" />}
    </span>
  );
}
