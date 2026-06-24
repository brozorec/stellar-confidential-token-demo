/** Parse a TEXT JSON column, returning the raw string if it isn't valid JSON. */
export function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
