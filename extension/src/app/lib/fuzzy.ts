// Fuzzy name search for the object tree: case-insensitive, spaces in the search ignored. A plain
// substring match wins; otherwise the search's letters must appear in order ("dtexres" finds
// "data_export_results"). Returns the matched character positions, for highlighting, or null.

export function fuzzyMatch(text: string, needle: string): number[] | null {
  const n = needle.toLowerCase().replace(/\s+/g, "");
  if (!n) return [];
  const t = text.toLowerCase();
  const at = t.indexOf(n);
  if (at >= 0) return Array.from({ length: n.length }, (_, i) => at + i);
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < t.length && j < n.length; i++) {
    if (t[i] === n[j]) {
      out.push(i);
      j++;
    }
  }
  return j === n.length ? out : null;
}

/** Splits text into runs, marking the matched positions: [["data_", false], ["exp", true], …]. */
export function markRuns(text: string, positions: number[]): [string, boolean][] {
  const hit = new Set(positions);
  const runs: [string, boolean][] = [];
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i);
    const last = runs[runs.length - 1];
    if (last && last[1] === on) last[0] += text[i];
    else runs.push([text[i]!, on]);
  }
  return runs;
}
