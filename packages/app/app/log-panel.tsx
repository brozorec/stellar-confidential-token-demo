/** Scrollable timestamped log output, shared by the wallet and advanced-mode pages. */
export function LogPanel({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;
  return (
    <pre className="mt-6 max-h-56 overflow-auto rounded border border-neutral-900 bg-neutral-500/10 p-3 text-xs text-neutral-400">
      {logs.join("\n")}
    </pre>
  );
}
