// Row counts in the object tree, as rough marks rather than exact numbers: "~24296136" → "~24M".
// Postgres estimates come as "~<n>"; other labels (sizes, engines, "1.2M rows") pass through.

/** "<100", "~450", "~10k", "~2.4M", "~24M", "~1.1B". */
export function approxCount(n: number): string {
  if (n < 100) return "<100";
  if (n < 1000) return `~${Math.round(n / 10) * 10}`;
  const [div, unit] = n >= 1e9 ? [1e9, "B"] : n >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const v = n / div;
  // One decimal below 10 (2.4M), whole numbers above (24M); 999.6k rounds up to 1M.
  const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  if (shown >= 1000 && unit !== "B") return approxCount(shown * div);
  return `~${shown}${unit}`;
}

/** A tree node's meta label with a bare or "~" row count rounded; anything else unchanged. */
export function roundedMeta(meta: string, type: string): string {
  // Group and schema counts ("Tables 12", "public 229") are object counts: exact is fine there.
  if (type === "group" || type === "schema" || type === "database" || type === "dataset") return meta;
  const m = /^~?(\d+)$/.exec(meta.trim());
  return m ? approxCount(Number(m[1])) : meta;
}
