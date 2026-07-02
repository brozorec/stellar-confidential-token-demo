"use client";

import { useCallback, useState } from "react";

/** Timestamped log lines, newest first, capped at `cap` entries. */
export function useLog(cap: number): [string[], (msg: string) => void] {
  const [logs, setLogs] = useState<string[]>([]);
  const log = useCallback(
    (msg: string) => {
      setLogs((prev) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...prev].slice(0, cap));
    },
    [cap],
  );
  return [logs, log];
}
