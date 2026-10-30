// Parameter panel helpers: guessing a variable's input type, and turning text typed in an input
// back into a value (and a value into text for the input).

import type { VarType } from "./model";

/** Type for a variable's input, from its name and default (DESIGN.md §3.14). */
export function guessVarType(name: string, value?: unknown, declared?: VarType): VarType {
  if (declared) return declared;
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (value && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  const n = name.toLowerCase();
  if (/(^|_)date$/.test(n) || /^(start|end|from|to)_?date/.test(n)) return "date";
  if (/_ids$/.test(n) || /^ids$/.test(n)) return "list";
  if (/^(limit|days|weeks|months|hours|offset|n|top_n|lookback_days)$/.test(n) || /_(days|count|limit)$/.test(n)) return "number";
  if (/^(is|has)_/.test(n)) return "boolean";
  return "string";
}

/** Text for an input showing `value`. */
export function formatVarInput(value: unknown, type: VarType): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (type === "list" && Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (type === "json" || (typeof value === "object" && value !== null)) return JSON.stringify(value);
  return String(value);
}

/** Value for text typed into an input. Empty text gives undefined (no value). */
export function parseVarInput(text: string, type: VarType): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  switch (type) {
    case "number": {
      const n = Number(t);
      return Number.isFinite(n) ? n : t;
    }
    case "boolean":
      return /^(true|1|yes)$/i.test(t);
    case "list":
      return t
        .split(/[,\n]/)
        .map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
        .filter((s) => s !== "")
        .map((s) => (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s) ? Number(s) : s));
    case "json":
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    default:
      return text;
  }
}
