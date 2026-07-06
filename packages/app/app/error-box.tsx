/** Shared inline error banner used across the persona pages. */
export function ErrorBox({
  children,
  className = "",
  size = "md",
}: {
  children: React.ReactNode;
  className?: string;
  /** "sm" — compact, for inline panel errors. "md" (default) — page-level errors. */
  size?: "sm" | "md";
}) {
  const sizeCls = size === "sm" ? "p-2 text-xs" : "p-3 text-sm";
  return (
    <div className={`rounded border border-red-800 bg-red-950/40 text-red-300 ${sizeCls} ${className}`}>
      {children}
    </div>
  );
}
