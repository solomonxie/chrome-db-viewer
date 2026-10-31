// Tab in the SQL editors: indents with 4 spaces instead of moving focus to the next control.
// With a multi-line selection, Tab indents every selected line and Shift+Tab outdents them.

export const INDENT = "    ";

export interface Edit {
  value: string;
  start: number;
  end: number;
}

/** The text and selection after Tab (outdent = Shift+Tab) at [start, end). */
export function applyTab(value: string, start: number, end: number, outdent: boolean): Edit {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const multi = value.slice(start, end).includes("\n");
  if (!outdent && !multi) {
    return { value: value.slice(0, start) + INDENT + value.slice(end), start: start + INDENT.length, end: start + INDENT.length };
  }
  // Whole lines from the first selected line to the last (a selection ending at a line start leaves that line out).
  const blockEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", blockEnd);
  const stop = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(lineStart, stop).split("\n");
  let firstShift = 0;
  let total = 0;
  const changed = lines.map((line, i) => {
    if (!outdent) {
      if (i === 0) firstShift = INDENT.length;
      total += INDENT.length;
      return INDENT + line;
    }
    const n = /^ {1,4}|^\t/.exec(line)?.[0].length ?? 0;
    if (i === 0) firstShift = -n;
    total -= n;
    return line.slice(n);
  });
  const next = value.slice(0, lineStart) + changed.join("\n") + value.slice(stop);
  return { value: next, start: Math.max(lineStart, start + firstShift), end: Math.max(lineStart, end + total) };
}

/**
 * Handles Tab / Shift+Tab on a textarea: returns true (and calls onChange, then restores the
 * selection) when it took the key. Modifier combos and IME composition are left alone.
 */
export function handleTabKey(e: React.KeyboardEvent<HTMLTextAreaElement>, onChange: (value: string) => void): boolean {
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return false;
  e.preventDefault();
  const el = e.currentTarget;
  const edit = applyTab(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
  if (edit.value !== el.value) onChange(edit.value);
  requestAnimationFrame(() => el.setSelectionRange(edit.start, edit.end));
  return true;
}
