/**
 * Small "what happens if you click this" hint shown to the right of a
 * hoverable element. Used by Addr ("Copy") and TxLink ("Open on
 * stellar.expert"). Parent element must have `group relative inline-block`.
 */
export function HoverTip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute top-1/2 left-full z-10 ml-1.5 -translate-y-1/2 whitespace-nowrap rounded bg-neutral-800 px-1.5 py-0.5 font-sans text-[10px] text-neutral-200 opacity-0 shadow transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {label}
    </span>
  );
}
