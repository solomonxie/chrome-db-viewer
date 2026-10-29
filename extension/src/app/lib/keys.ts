// Keyboard combos like "mod+shift+p", "alt+t", "mod+enter". "mod" is ⌘ on macOS, Ctrl elsewhere.

import { useEffect, useRef } from "react";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Browser shortcuts dbui takes inside app.html (DESIGN.md §3.6). */
export const RESERVED = ["mod+s", "mod+k", "mod+r", "mod+f", "mod+p"];

export function comboOf(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac = isMac): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (mac && e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  // With ⌥ held, e.key is a special character on macOS; use the physical key instead.
  let key = e.key;
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code) && e.shiftKey) key = e.code.slice(5);
  else if (e.code === "Backslash") key = "\\";
  else if (e.code === "BracketLeft") key = "[";
  else if (e.code === "BracketRight") key = "]";
  else if (e.code === "Period") key = ".";
  parts.push(key.length === 1 ? key.toLowerCase() : key.toLowerCase());
  return parts.join("+");
}

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

export interface KeyOptions {
  /** Bare keys (no modifier) that still fire while focus is in a text field. */
  inFields?: string[];
  /** Modifier combos that must NOT fire in a text field (⌘Z, ⌘⌫ keep their native meaning). */
  notInFields?: string[];
  /** Turns the whole map off, e.g. while a modal is open. */
  disabled?: boolean;
}

/**
 * Window-level shortcuts. Combos with ⌘/Ctrl or ⌥ fire even while typing; bare keys
 * (Escape, Delete …) only fire when focus is not in a field, unless listed in `inFields`.
 */
export function useKeys(map: KeyMap, opts: KeyOptions = {}): void {
  const ref = useRef({ map, opts });
  ref.current = { map, opts };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { map: m, opts: o } = ref.current;
      // Not checking defaultPrevented: the reserved-key guard already prevents ⌘S etc.
      if (o.disabled) return;
      const combo = comboOf(e);
      const handler = m[combo];
      if (!handler) return;
      const typing = isTyping(e.target);
      const hasMod = combo.startsWith("mod+") || combo.startsWith("alt+") || combo.startsWith("ctrl+");
      if (typing && !hasMod && !o.inFields?.includes(combo)) return;
      if (typing && o.notInFields?.includes(combo)) return;
      // An open modal, palette or confirm owns the keyboard.
      if (document.querySelector(".scrim")) return;
      e.preventDefault();
      e.stopPropagation();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Swallows Chrome's own ⌘S/⌘K/⌘R/⌘F/⌘P everywhere in the app tab. */
export function installReservedKeyGuard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (RESERVED.includes(comboOf(e))) e.preventDefault();
  };
  window.addEventListener("keydown", onKey, { capture: true });
  return () => window.removeEventListener("keydown", onKey, { capture: true });
}

export const MOD = isMac ? "⌘" : "Ctrl+";
export const ALT = isMac ? "⌥" : "Alt+";
export const SHIFT = isMac ? "⇧" : "Shift+";
